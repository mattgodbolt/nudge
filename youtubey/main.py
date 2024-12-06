import json
from pathlib import Path
from dataclasses import dataclass
from typing import List, Dict, Optional, Tuple
import click
from googleapiclient.discovery import build


@dataclass(frozen=True, kw_only=True)
class Context:
    api_key_filename: Path

    @property
    def api_key(self) -> str:
        return self.api_key_filename.read_text(encoding="utf-8")


@click.group()
@click.option(
    "--api-key-file",
    metavar="PATH",
    type=click.Path(dir_okay=False, exists=True, path_type=Path),
    default=Path.home() / ".youtubey-key",
)
@click.pass_context
def cli(ctx: click.Context, api_key_file: Path) -> None:
    ctx.obj = Context(api_key_filename=api_key_file)


class YouTubeCommentMonitor:
    def __init__(self, api_key: str, state_file: Path) -> None:
        self.youtube = build("youtube", "v3", developerKey=api_key)
        self.state_file = state_file
        self.seen_comments = self._load_state()

    def _load_state(self) -> Dict[str, List[str]]:
        if self.state_file.is_file():
            with self.state_file.open("r", encoding="utf-8") as f:
                return json.load(f)
        return {}

    def _save_state(self) -> None:
        with self.state_file.open("w", encoding="utf-8") as f:
            json.dump(self.seen_comments, f, indent=2)

    def get_playlist_video_ids(self, playlist_id: str) -> List[str]:
        video_ids = []
        next_page_token: Optional[str] = None

        while True:
            request = self.youtube.playlistItems().list(
                part="snippet",
                playlistId=playlist_id,
                maxResults=50,
                pageToken=next_page_token,
            )

            response = request.execute()

            for item in response["items"]:
                video_ids.append(item["snippet"]["resourceId"]["videoId"])

            next_page_token = response.get("nextPageToken")
            if not next_page_token:
                break

        return video_ids

    def get_new_comments(self, video_ids: List[str]) -> Dict[str, List[Dict[str, str]]]:
        new_comments: Dict[str, List[Dict[str, str]]] = {}

        for video_id in video_ids:
            if video_id not in self.seen_comments:
                self.seen_comments[video_id] = []

            try:
                request = self.youtube.commentThreads().list(
                    part="snippet",
                    videoId=video_id,
                    maxResults=100,
                    order="time",
                )

                while request:
                    response = request.execute()

                    for item in response["items"]:
                        comment = {
                            "id": item["id"],
                            "author": item["snippet"]["topLevelComment"]["snippet"]["authorDisplayName"],
                            "text": item["snippet"]["topLevelComment"]["snippet"]["textDisplay"],
                            "timestamp": item["snippet"]["topLevelComment"]["snippet"]["publishedAt"],
                            "likes": item["snippet"]["topLevelComment"]["snippet"]["likeCount"],
                            "reply_count": item["snippet"]["totalReplyCount"],
                        }

                        if comment["id"] not in self.seen_comments[video_id]:
                            if video_id not in new_comments:
                                new_comments[video_id] = []
                            new_comments[video_id].append(comment)
                            self.seen_comments[video_id].append(comment["id"])

                    request = self.youtube.commentThreads().list_next(request, response)

            except Exception as e:
                print(f"Error fetching comments for video {video_id}: {str(e)}")
                continue

        self._save_state()
        return new_comments


def get_video_watch_counts(channel_id: str, api_key: str) -> List[Dict[str, str]]:
    youtube = build("youtube", "v3", developerKey=api_key)
    video_details: List[Dict[str, str]] = []

    channel_response = youtube.channels().list(part="contentDetails", id=channel_id).execute()
    uploads_playlist_id = channel_response["items"][0]["contentDetails"]["relatedPlaylists"]["uploads"]

    next_page_token: Optional[str] = None
    while True:
        playlist_response = (
            youtube.playlistItems()
            .list(
                part="snippet",
                playlistId=uploads_playlist_id,
                maxResults=50,
                pageToken=next_page_token,
            )
            .execute()
        )

        for playlist_item in playlist_response["items"]:
            video_id = playlist_item["snippet"]["resourceId"]["videoId"]

            stats_response = youtube.videos().list(part="statistics", id=video_id).execute()

            video_info = {
                "title": playlist_item["snippet"]["title"],
                "video_id": video_id,
                "view_count": int(stats_response["items"][0]["statistics"].get("viewCount", 0)),
                "published_at": playlist_item["snippet"]["publishedAt"],
            }

            video_details.append(video_info)

        next_page_token = playlist_response.get("nextPageToken")
        if not next_page_token:
            break

    return video_details


@cli.command(name="new-comments")
@click.option("--state-file", type=Path, default=Path.home() / ".youtubey-state.json")
@click.option("--playlist")
@click.argument("video_ids", type=str, nargs=-1)
@click.pass_obj
def new_comments_cmd(ctx: Context, state_file: Path, playlist: Optional[str], video_ids: Tuple[str, ...]) -> None:
    monitor = YouTubeCommentMonitor(ctx.api_key, state_file)
    try:
        playlist_video_ids = []
        if playlist is not None:
            playlist_video_ids = monitor.get_playlist_video_ids(playlist)
        new_comments = monitor.get_new_comments(list(video_ids) + playlist_video_ids)

        for video_id, comments in new_comments.items():
            if comments:
                print(f"\nNew comments for video {video_id}:")
                print("-" * 50)
                for comment in comments:
                    print(f"Author: {comment['author']}")
                    print(f"Comment: {comment['text']}")
                    print(f"Posted at: {comment['timestamp']}")
                    print(f"Likes: {comment['likes']}")
                    print(f"Replies: {comment['reply_count']}")
                    print("-" * 50)
            else:
                print(f"\nNo new comments for video {video_id}")

    except Exception as e:
        print(f"An error occurred: {e}")


@cli.command(name="watch-counts")
@click.argument("channel_id", type=str, default="UC9-y-6csu5WGm29I7JiwpnA")
@click.pass_obj
def watch_counts(ctx: Context, channel_id: str) -> None:
    try:
        videos = get_video_watch_counts(channel_id, ctx.api_key)

        print("Video Watch Counts:")
        for video in videos:
            print(f"Title: {video['title']}")
            print(f"View Count: {video['view_count']:,}")
            print(f"Published: {video['published_at']}")
            print("---")

    except RuntimeError as e:
        print(f"An error occurred: {e}")


if __name__ == "__main__":
    cli()
