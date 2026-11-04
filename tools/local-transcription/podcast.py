"""Resolve public podcast episodes, without Spotify playback or authentication."""

from datetime import datetime
from email.utils import parsedate_to_datetime
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
import unicodedata
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request
import xml.etree.ElementTree as ET
import base64

# Deliberately bounded to public podcast hosts/CDNs, not arbitrary URLs supplied
# by a page. Every redirect is checked, including media tracking redirects.
PUBLIC_HOSTS = (
    "open.spotify.com", "itunes.apple.com", "anchor.fm", "cloudfront.net",
    "megaphone.fm", "simplecast.com", "simplecastaudio.com", "buzzsprout.com",
    "libsyn.com", "podbean.com", "omny.fm", "omnystudio.com", "acast.com",
    "art19.com", "podtrac.com", "chtbl.com", "pscrb.fm", "spotifycdn.com",
)
ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd"
PODCAST = "https://podcastindex.org/namespace/1.0"


def public_url(value):
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    if (parsed.scheme != "https" or parsed.username or parsed.password or
            parsed.port not in (None, 443) or not any(
                host == domain or host.endswith("." + domain) for domain in PUBLIC_HOSTS)):
        raise ValueError(f"Unsupported public podcast host: {host or '(none)'}. "
                         "Only HTTPS public podcast feeds and supported CDNs can be used.")
    return value


class PublicRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        public_url(new_url)
        return super().redirect_request(request, response, code, message, headers, new_url)


def open_public(url):
    return build_opener(PublicRedirects()).open(
        Request(public_url(url), headers={"User-Agent": "TranscriptExtractor/0.1"}), timeout=30)


def fetch(url, limit=10 * 1024 * 1024):
    with open_public(url) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Public podcast metadata or transcript exceeds the size limit.")
    return data


class InitialState(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.data = []

    def handle_starttag(self, tag, attributes):
        if tag == "script":
            self.active = dict(attributes).get("id") == "initialState"

    def handle_data(self, data):
        if self.active:
            self.data.append(data)

    def handle_endtag(self, tag):
        if tag == "script":
            self.active = False


def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def seconds(value):
    parts = value.strip().split(":")
    if not 1 <= len(parts) <= 3:
        raise ValueError("Unsupported podcast duration.")
    result = 0.0
    for part in parts:
        result = result * 60 + float(part)
    return result


def resolve_episode(url):
    parsed = urlsplit(url)
    match = re.fullmatch(r"/episode/([A-Za-z0-9]{22})", parsed.path)
    if parsed.hostname != "open.spotify.com" or not match or parsed.query or parsed.fragment:
        raise ValueError("A canonical Spotify podcast episode URL is required.")
    parser = InitialState()
    parser.feed(fetch(url).decode("utf-8"))
    state = json.loads(base64.b64decode("".join(parser.data)))
    identifier = match[1]
    episode = state["entities"]["items"]["spotify:episode:" + identifier]
    if episode.get("id") != identifier:
        raise ValueError("Spotify returned metadata for a different episode.")
    duration = episode["duration"]["totalMilliseconds"] / 1000
    if not 0 < duration <= 24 * 3600:
        raise ValueError("The full podcast duration is unavailable or exceeds 24 hours.")
    show = episode["showOrAudiobook"]["data"]
    release = datetime.fromisoformat(episode["releaseDate"]["isoString"].replace("Z", "+00:00"))
    directory = json.loads(fetch("https://itunes.apple.com/search?" + urlencode({
        "term": show["name"], "entity": "podcast", "limit": 10,
    })))
    candidates = {item["feedUrl"] for item in directory.get("results", [])
                  if item.get("feedUrl") and normalized(item.get("collectionName", "")) == normalized(show["name"])}
    matches = []
    failures = []
    for feed_url in sorted(candidates)[:5]:
        try:
            channel = ET.fromstring(fetch(feed_url)).find("channel")
            if channel is None or normalized(channel.findtext("title", "")) != normalized(show["name"]):
                continue
            for item in channel.findall("item"):
                if normalized(item.findtext("title", "")) != normalized(episode["name"]):
                    continue
                date = parsedate_to_datetime(item.findtext("pubDate", ""))
                item_duration = seconds(item.findtext(f"{{{ITUNES}}}duration", ""))
                if abs((date - release).total_seconds()) > 86400:
                    continue
                if abs(item_duration - duration) > max(120, duration * 0.1):
                    continue
                enclosures = [node.get("url") for node in item.findall("enclosure")
                              if node.get("type", "").startswith("audio/") and node.get("url")]
                if len(enclosures) != 1:
                    continue
                audio_url = public_url(enclosures[0])
                transcripts = [node.attrib for node in item.findall(f"{{{PODCAST}}}transcript")]
                matches.append({"url": audio_url, "duration": duration, "name": episode["name"],
                                "transcripts": transcripts, "source": url})
        except (ValueError, KeyError, ET.ParseError, OSError) as error:
            failures.append(str(error))
    unique = {item["url"]: item for item in matches}
    if len(unique) != 1:
        reason = " ".join(failures) if failures else "No unique episode matched its title, date and full duration."
        raise ValueError("Could not locate a supported full public podcast episode. "
                         "Spotify-exclusive/protected playback and preview clips are not used. " + reason)
    return next(iter(unique.values()))


def download_audio(url, path: Path):
    total = 0
    started = time.monotonic()
    with open_public(url) as response, path.open("xb") as output:
        if int(response.headers.get("Content-Length", "0")) > 2 * 1024**3:
            raise ValueError("Podcast audio exceeds the 2 GB limit.")
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > 2 * 1024**3 or time.monotonic() - started > 1800:
                raise ValueError("Podcast download exceeded the size or time limit.")
            output.write(chunk)
    if not total:
        raise ValueError("The publisher returned empty audio.")


def published_transcript(episode, format_):
    """Use supported publisher captions before spending CPU on Whisper."""
    failures = []
    for entry in episode["transcripts"]:
        mime = entry.get("type", "").split(";")[0].strip().lower()
        if mime not in ("text/vtt", "application/x-subrip", "application/srt", "application/json"):
            failures.append("Unsupported publisher transcript type: " + mime)
            continue
        try:
            raw = fetch(entry["url"], 5 * 1024 * 1024).decode("utf-8-sig")
            cues = []
            if mime == "application/json":
                for segment in json.loads(raw)["segments"]:
                    cues.append((float(segment["startTime"]), float(segment["endTime"]),
                                 str(segment["body"]), str(segment.get("speaker", ""))))
            else:
                for block in re.split(r"\r?\n\s*\r?\n", raw.strip()):
                    lines = block.splitlines()
                    timing = next((i for i, line in enumerate(lines) if " --> " in line), None)
                    if timing is None:
                        continue
                    match = re.fullmatch(r"([\d:.,]+)\s+-->\s+([\d:.,]+)(?:\s+.*)?", lines[timing])
                    if not match:
                        raise ValueError("Invalid publisher caption timing.")
                    body = "\n".join(lines[timing + 1:])
                    voice = re.search(r"<v(?:\.[^\s>]*)?\s+([^>]+)>", body)
                    text = html.unescape(re.sub(r"<[^>]+>", "", body)).strip()
                    cues.append((seconds(match[1].replace(",", ".")), seconds(match[2].replace(",", ".")),
                                 text, html.unescape(voice[1]) if voice else ""))
            previous = -1
            for start, end, text, _ in cues:
                if not text or not 0 <= start < end <= episode["duration"] + 120 or start < previous:
                    raise ValueError("Invalid publisher transcript cues.")
                previous = start
            if not cues or max(cue[1] for cue in cues) < episode["duration"] * 0.9 - 2:
                raise ValueError("The publisher transcript is empty or partial.")

            def stamp(value):
                ms = round(value * 1000)
                return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02}.{ms % 1000:03}"

            if format_ == "vtt":
                return "WEBVTT\n\n" + "\n\n".join(
                    f"{i}\n{stamp(start)} --> {stamp(end)}\n" +
                    (f"<v {html.escape(speaker)}>{html.escape(text)}</v>" if speaker else html.escape(text))
                    for i, (start, end, text, speaker) in enumerate(cues, 1)), failures
            escape = lambda text: re.sub(r"([\\`*_{}\[\]<>#!|])", r"\\\1", text)
            return f"# {escape(episode['name'])}\n\nSource: {episode['source']}\n\nPublished podcast transcript.\n\n" + \
                "\n\n".join(f"**[{stamp(start)}]{' ' + escape(speaker) if speaker else ''}**\n\n{escape(text)}"
                            for start, _, text, speaker in cues) + "\n", failures
        except (ValueError, KeyError, TypeError, OSError) as error:
            failures.append(str(error))
    return None, failures
