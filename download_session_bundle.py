#!/usr/bin/env python3
"""
download_session_bundle.py

Fetches traces from W8-Haloop collector for a specified project,
retrieves any associated Harbor evaluation task package,
and compiles a standardized OpenHands Session Capture Packet (.tar.gz).

Defaults to saving the packet in the user's Downloads folder.
"""

import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
from typing import Any

# Ensure halo-loop is on sys.path
SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent if (SCRIPT_DIR.parent / "halo-loop").exists() else SCRIPT_DIR.parent / "w8-haloop"
if not (REPO_ROOT / "halo-loop").exists():
    # If placed inside w8-haloop/scripts/
    if (SCRIPT_DIR.parent / "halo-loop").exists():
        REPO_ROOT = SCRIPT_DIR.parent
    else:
        # Fallback to local desktop path
        REPO_ROOT = pathlib.Path(r"C:\Users\dines\OneDrive\Desktop\work\w8-haloop")

HALO_LOOP_DIR = REPO_ROOT / "halo-loop"

if str(HALO_LOOP_DIR) not in sys.path:
    sys.path.insert(0, str(HALO_LOOP_DIR))

try:
    from services.byoh.session_bundle import build_session_bundle_bytes
except ImportError as exc:
    sys.exit(f"Error importing build_session_bundle_bytes from {HALO_LOOP_DIR}: {exc}")


DEFAULT_COLLECTOR_URL = os.environ.get("HALOOP_COLLECTOR_URL", "")
DEFAULT_ADMIN_TOKEN = os.environ.get("BYOH_ADMIN_TOKEN", "")


def get_default_download_dir() -> pathlib.Path:
    user_downloads = pathlib.Path.home() / "Downloads"
    if user_downloads.exists():
        return user_downloads
    local_downloads = pathlib.Path.cwd() / "downloads"
    local_downloads.mkdir(parents=True, exist_ok=True)
    return local_downloads


def fetch_json(url: str, headers: dict[str, str] | None = None) -> tuple[int, Any]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
            return resp.status, json.loads(data.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            err_data = json.loads(exc.read().decode("utf-8"))
        except Exception:
            err_data = str(exc)
        return exc.code, err_data
    except Exception as exc:
        return 0, str(exc)


def fetch_bytes(url: str, headers: dict[str, str] | None = None) -> tuple[int, bytes | None, str | None]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            content_disp = resp.headers.get("Content-Disposition", "")
            filename = None
            if "filename=" in content_disp:
                filename = content_disp.split("filename=")[-1].strip('"\' ')
            return resp.status, resp.read(), filename
    except Exception:
        return 0, None, None


def list_projects(collector_url: str) -> list[str]:
    status, projects = fetch_json(f"{collector_url.rstrip('/')}/projects")
    if status == 200 and isinstance(projects, list):
        return projects
    return []


def download_session_bundle(
    project: str,
    collector_url: str = DEFAULT_COLLECTOR_URL,
    admin_token: str = DEFAULT_ADMIN_TOKEN,
    output_dir: pathlib.Path | None = None,
    include_harbor: bool = True,
) -> pathlib.Path:
    collector_url = collector_url.rstrip("/")
    if output_dir is None:
        output_dir = get_default_download_dir()
    output_dir = pathlib.Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Connecting to W8-Haloop collector at {collector_url}...")

    # 1. Fetch traces for the project
    traces_url = f"{collector_url}/traces?project={project}&limit=100000"
    print(f"Fetching traces for project '{project}'...")
    status, spans = fetch_json(traces_url)

    if status != 200 or not isinstance(spans, list):
        raise RuntimeError(f"Failed to fetch traces for project '{project}': {spans}")

    if not spans:
        available = list_projects(collector_url)
        raise ValueError(
            f"No traces found for project '{project}'.\n"
            f"Available projects: {', '.join(available[:15])}{'...' if len(available) > 15 else ''}"
        )

    print(f"Retrieved {len(spans)} traces/spans for project '{project}'.")

    # 2. Optionally fetch associated Harbor task package
    harbor_bytes = None
    harbor_name = None

    if include_harbor and admin_token:
        print("Checking for associated Harbor rollout and generated task package...")
        rollouts_url = f"{collector_url}/v1/byoh/reward-rollouts?limit=50"
        auth_headers = {"Authorization": f"Bearer {admin_token}"}
        status, rollouts = fetch_json(rollouts_url, headers=auth_headers)

        if status == 200 and isinstance(rollouts, list):
            matching = [
                r for r in rollouts
                if (
                    r.get("request", {}).get("source_project") == project
                    or r.get("request", {}).get("metadata", {}).get("project") == project
                    or r.get("request", {}).get("source_task", {}).get("task") == project
                )
            ]
            if matching:
                latest = matching[0]
                rollout_id = latest.get("id")
                print(f"Found matching rollout: {rollout_id} (phase: {latest.get('phase')})")

                # Try downloading task package
                dl_url = f"{collector_url}/v1/byoh/reward-rollouts/{rollout_id}/task/download"
                dl_status, dl_data, dl_filename = fetch_bytes(dl_url, headers=auth_headers)
                if dl_status == 200 and dl_data:
                    harbor_bytes = dl_data
                    if dl_filename and dl_filename.endswith(".tar.gz"):
                        harbor_name = dl_filename[:-7]
                    elif dl_filename:
                        harbor_name = dl_filename
                    else:
                        harbor_name = "harbor-task"
                    print(f"Successfully attached Harbor task package: '{harbor_name}' ({len(harbor_bytes)} bytes).")
                else:
                    print("No downloadable task package found for rollout.")
            else:
                print("No matching Harbor rollouts found for this project.")
        else:
            print("Rollouts API unavailable or unauthenticated; proceeding without Harbor task.")

    # 3. Build session bundle bytes
    print("Building standardized OpenHands Session Capture Packet (.tar.gz)...")
    bundle_data, digest = build_session_bundle_bytes(
        spans=spans,
        project_name=project,
        harbor_task_bytes=harbor_bytes,
        harbor_task_name=harbor_name,
    )

    output_filename = f"{project}-openhands-session.tar.gz"
    output_path = output_dir / output_filename

    print(f"Writing session packet to {output_path}...")
    output_path.write_bytes(bundle_data)

    size_mb = len(bundle_data) / (1024 * 1024)
    print("\nSession packet downloaded successfully!")
    print(f"  File:        {output_path.resolve()}")
    print(f"  Size:        {size_mb:.2f} MB ({len(bundle_data):,} bytes)")
    print(f"  SHA-256:     {digest}")
    print(f"  Spans:       {len(spans)}")
    if harbor_name:
        print(f"  Harbor Task: {harbor_name}")

    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download OpenHands Session Capture Packet (.tar.gz) from W8-Haloop collector."
    )
    parser.add_argument(
        "project",
        nargs="?",
        default="tstbbh",
        help="Target project name (e.g., 'tstbbh'). Defaults to 'tstbbh'.",
    )
    parser.add_argument(
        "--collector-url",
        default=DEFAULT_COLLECTOR_URL,
        help=f"W8-Haloop collector endpoint URL (default: {DEFAULT_COLLECTOR_URL})",
    )
    parser.add_argument(
        "--admin-token",
        default=DEFAULT_ADMIN_TOKEN,
        help="Admin Bearer token for BYOH rollouts authentication.",
    )
    parser.add_argument(
        "-o", "--output-dir",
        default=None,
        help="Directory to save the session bundle. Defaults to user's Downloads folder.",
    )
    parser.add_argument(
        "--no-harbor",
        action="store_true",
        help="Skip checking and embedding associated Harbor evaluation tasks.",
    )
    parser.add_argument(
        "--list-projects",
        action="store_true",
        help="List all available projects on the collector and exit.",
    )

    args = parser.parse_args()

    if args.list_projects:
        projects = list_projects(args.collector_url)
        print(f"Found {len(projects)} projects on {args.collector_url}:\n")
        for p in projects:
            print(f"  - {p}")
        return

    out_dir = pathlib.Path(args.output_dir) if args.output_dir else get_default_download_dir()
    download_session_bundle(
        project=args.project,
        collector_url=args.collector_url,
        admin_token=args.admin_token,
        output_dir=out_dir,
        include_harbor=not args.no_harbor,
    )


if __name__ == "__main__":
    main()
