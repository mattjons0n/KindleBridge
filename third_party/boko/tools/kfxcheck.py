#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pillow",
#     "lxml",
#     "pypdf",
#     "beautifulsoup4",
# ]
# ///
"""kfxcheck — validate Amazon KFX books, in the spirit of epubcheck.

Runs the structural checks from jhowell's kfxlib (the calibre KFX Input/Output
plugins) against one or more KFX/KPF/KFX-ZIP files and reports errors and
warnings:

  - container and fragment consistency (unknown/duplicate/missing fragments,
    entity map coverage, required fragment types)
  - symbol table integrity (missing/unused symbols)
  - unknown format features and metadata problems
  - position and location map verification (skip with --fast)
  - a full trial conversion to EPUB, which exercises content, style, and
    navigation decoding end to end (skip with --no-epub or --fast)

kfxlib is not on PyPI. The script looks for a local checkout of the KFX Input
plugin source (--kfxlib, $KFXCHECK_KFXLIB, or ~/code/kfx); failing that, it
downloads the plugin from plugins.calibre-ebook.com into a cache directory
(~/.cache/kfxcheck) and uses that. --update refreshes the cached copy. Only
the KFX Input plugin is needed — its kfxlib is a superset of the Output
plugin's.

Exit codes: 0 = valid, 1 = validation errors, 2 = file could not be processed,
3 = usage/configuration error.
"""

import argparse
import io
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.request
import zipfile

KFXLIB_CANDIDATES = [
    os.environ.get("KFXCHECK_KFXLIB"),
    "~/code/kfx/kfx_input",
    "~/code/kfx/kfx_output",
    "~/code/kfx",
]

KFX_INPUT_PLUGIN_URL = "https://plugins.calibre-ebook.com/291290.zip"

KFX_EXTENSIONS = {".kfx", ".kpf", ".azw8", ".kfx-zip", ".zip", ".ion"}

SEVERITY_ORDER = {"fatal": 0, "error": 1, "warning": 2, "info": 3}

CATEGORY_PATTERNS = [
    ("drm", re.compile(r"\bDRM\b", re.I)),
    ("entity-map", re.compile(r"entity map|entity_map|container_entity_map", re.I)),
    ("container", re.compile(r"\bcontainers?\b", re.I)),
    ("symbols", re.compile(r"symbol", re.I)),
    ("positions", re.compile(r"position|location|\beids?\b|\bpids?\b|content chunk", re.I)),
    ("features", re.compile(r"feature", re.I)),
    ("metadata", re.compile(r"metadata|cover|asset_id", re.I)),
    ("fragments", re.compile(r"fragment", re.I)),
    ("epub", re.compile(r"epub|html|css", re.I)),
]


def categorize(message):
    for category, pattern in CATEGORY_PATTERNS:
        if pattern.search(message):
            return category
    return "general"


class CheckLogger:
    """Captures kfxlib's thread-local log stream as (severity, message) records."""

    def __init__(self):
        self.records = []

    def _add(self, severity, message):
        message = str(message)
        self.records.append({
            "severity": severity,
            "category": categorize(message),
            "message": message,
        })

    def debug(self, message):
        self._add("info", message)

    def info(self, message):
        self._add("info", message)

    def warning(self, message):
        self._add("warning", message)

    warn = warning

    def error(self, message):
        self._add("error", message)

    def exception(self, message):
        self._add("error", message)

    def __call__(self, *args):
        self._add("info", " ".join(str(arg) for arg in args))

    def count(self, severity):
        return sum(1 for record in self.records if record["severity"] == severity)


def cache_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(base, "kfxcheck")


def download_plugin(update=False):
    """Fetch the KFX Input plugin into the cache and return its directory."""
    plugin_dir = os.path.join(cache_dir(), "kfx_input")
    marker = os.path.join(plugin_dir, "kfxlib", "yj_book.py")
    if os.path.isfile(marker) and not update:
        return plugin_dir

    print("kfxcheck: downloading KFX Input plugin from %s ..." % KFX_INPUT_PLUGIN_URL,
          file=sys.stderr)
    try:
        with urllib.request.urlopen(KFX_INPUT_PLUGIN_URL, timeout=60) as response:
            payload = response.read()
        with tempfile.TemporaryDirectory() as staging:
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                archive.extractall(staging)
            if not os.path.isfile(os.path.join(staging, "kfxlib", "yj_book.py")):
                raise Exception("downloaded archive does not contain kfxlib/yj_book.py")
            os.makedirs(os.path.dirname(plugin_dir), exist_ok=True)
            if os.path.isdir(plugin_dir):
                shutil.rmtree(plugin_dir)
            shutil.move(staging, plugin_dir)
    except Exception as e:
        print("kfxcheck: plugin download failed: %r" % e, file=sys.stderr)
        return None

    return plugin_dir


def resolve_kfxlib(explicit, update=False):
    if update:
        return download_plugin(update=True)
    candidates = [explicit] if explicit else KFXLIB_CANDIDATES
    for candidate in candidates:
        if not candidate:
            continue
        root = os.path.expanduser(candidate)
        for subdir in ("", "kfx_input", "kfx_output"):
            plugin_dir = os.path.join(root, subdir) if subdir else root
            if os.path.isfile(os.path.join(plugin_dir, "kfxlib", "yj_book.py")):
                return plugin_dir
    if explicit:
        return None
    return download_plugin()


def gather_book_info(book):
    info = {}

    def best_effort(key, fn):
        try:
            value = fn()
            if value not in (None, ""):
                info[key] = value
        except Exception:
            pass

    best_effort("title", lambda: book.get_metadata_value("title"))
    best_effort("author", lambda: book.get_metadata_value("author"))
    best_effort("asset_id", lambda: book.get_asset_id())
    best_effort("issue_date", lambda: book.get_metadata_value("issue_date"))
    best_effort("generators", lambda: sorted(
        "%s/%s" % generator if generator[1] else generator[0]
        for generator in book.get_generators()) or None)
    best_effort("fragments", lambda: len(book.fragments))
    for flag in ("is_dictionary", "is_scribe_notebook", "is_kpf_prepub",
                 "is_magazine", "is_print_replica", "is_sample", "is_kfx_v1"):
        try:
            if bool(getattr(book, flag)):
                info[flag] = True
        except Exception:
            pass
    return info


def validate_file(path, kfxlib_modules, deep=False, epub=False, symbol_catalog=None):
    yj_book, message_logging, KFXDRMError = kfxlib_modules
    logger = CheckLogger()
    message_logging.set_logger(logger)
    fatal = None
    info = {}

    try:
        book = yj_book.YJ_Book(path, symbol_catalog_filename=symbol_catalog)
        try:
            book.decode_book(pure=True)
        except KFXDRMError as e:
            logger.error("Book is DRM protected and cannot be validated: %s" % e)
            fatal = "drm"
        else:
            info = gather_book_info(book)

            if deep:
                try:
                    book.check_position_and_location_maps()
                except Exception as e:
                    logger.error("Position/location map verification failed: %r" % e)

            if epub:
                try:
                    epub_data = book.convert_to_epub()
                    info["epub_size"] = len(epub_data)
                except Exception as e:
                    logger.error("Trial EPUB conversion failed: %r" % e)
    except KFXDRMError as e:
        logger.error("Book is DRM protected and cannot be validated: %s" % e)
        fatal = "drm"
    except Exception as e:
        if type(e).__name__ == "JSONDecodeError":
            logger.error("Container kfxgen_info metadata is not parseable "
                         "(malformed generator info block): %r" % e)
        else:
            logger.error("Failed to process file: %r" % e)
        fatal = "exception"
    finally:
        message_logging.set_logger(None)

    errors = logger.count("error")
    warnings = logger.count("warning")
    status = "fatal" if fatal else ("invalid" if errors else "valid")
    return {
        "path": path,
        "status": status,
        "errors": errors,
        "warnings": warnings,
        "messages": logger.records,
        "info": info,
    }


def dedupe(records):
    seen = {}
    ordered = []
    for record in records:
        key = (record["severity"], record["message"])
        if key in seen:
            seen[key]["count"] += 1
        else:
            entry = dict(record, count=1)
            seen[key] = entry
            ordered.append(entry)
    return ordered


def print_report(result, verbose, quiet, out):
    show = {"error"}
    if not quiet:
        show.add("warning")
    if verbose:
        show.add("info")

    for record in dedupe(result["messages"]):
        if record["severity"] not in show:
            continue
        suffix = " (x%d)" % record["count"] if record["count"] > 1 else ""
        print("%s(%s): %s%s" % (
            record["severity"].upper(), record["category"], record["message"], suffix),
            file=out)

    info = result["info"]
    if verbose and info:
        described = ", ".join("%s=%s" % (key, value) for key, value in sorted(info.items()))
        print("INFO(book): %s" % described, file=out)

    print("%s: %s — %d error%s, %d warning%s" % (
        result["path"], result["status"].upper(),
        result["errors"], "" if result["errors"] == 1 else "s",
        result["warnings"], "" if result["warnings"] == 1 else "s"),
        file=out)


def expand_paths(paths):
    expanded = []
    for path in paths:
        if os.path.isdir(path):
            entries = sorted(
                os.path.join(path, name) for name in os.listdir(path)
                if os.path.splitext(name)[1].lower() in KFX_EXTENSIONS - {".zip", ".ion"})
            if entries:
                expanded.extend(entries)
            else:
                expanded.append(path)
        else:
            expanded.append(path)
    return expanded


def main():
    parser = argparse.ArgumentParser(
        prog="kfxcheck",
        description="Validate KFX books using jhowell's kfxlib (like epubcheck, for KFX).")
    parser.add_argument("paths", nargs="+", metavar="FILE",
                        help="KFX/KPF/AZW8/KFX-ZIP file (or a directory of them)")
    parser.add_argument("--kfxlib", metavar="DIR",
                        help="path to KFX plugin source containing kfxlib/ "
                             "(default: $KFXCHECK_KFXLIB, ~/code/kfx, or an "
                             "auto-downloaded copy in ~/.cache/kfxcheck)")
    parser.add_argument("--update", action="store_true",
                        help="re-download the cached KFX Input plugin and use it")
    parser.add_argument("-f", "--fast", action="store_true",
                        help="structural checks only: skip position/location map "
                             "verification and the trial EPUB conversion")
    parser.add_argument("--no-epub", action="store_true",
                        help="skip the trial in-memory EPUB conversion (keep other deep checks)")
    parser.add_argument("--symbol-catalog", metavar="FILE",
                        help="Ion symbol catalog file for translating unknown symbols")
    parser.add_argument("--json", action="store_true", dest="json_output",
                        help="emit a JSON report instead of text")
    parser.add_argument("-q", "--quiet", action="store_true",
                        help="report errors only (suppress warnings)")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="also show informational messages and book details")
    parser.add_argument("-W", "--fail-on-warnings", action="store_true",
                        help="exit non-zero if warnings are found")
    args = parser.parse_args()

    plugin_dir = resolve_kfxlib(args.kfxlib, update=args.update)
    if plugin_dir is None:
        print("kfxcheck: cannot find or download kfxlib; pass --kfxlib or set "
              "$KFXCHECK_KFXLIB to a KFX plugin source directory (containing kfxlib/)",
              file=sys.stderr)
        return 3

    sys.path.insert(0, plugin_dir)
    from kfxlib import message_logging, yj_book
    from kfxlib.utilities import KFXDRMError
    kfxlib_modules = (yj_book, message_logging, KFXDRMError)

    results = []
    out = io.StringIO() if args.json_output else sys.stdout
    for path in expand_paths(args.paths):
        if not os.path.exists(path):
            results.append({
                "path": path, "status": "fatal", "errors": 1, "warnings": 0,
                "messages": [{"severity": "error", "category": "general",
                              "message": "File does not exist"}],
                "info": {},
            })
        else:
            results.append(validate_file(
                path, kfxlib_modules, deep=not args.fast,
                epub=not (args.fast or args.no_epub),
                symbol_catalog=args.symbol_catalog))
        if not args.json_output:
            print_report(results[-1], args.verbose, args.quiet, out)

    total_errors = sum(result["errors"] for result in results)
    total_warnings = sum(result["warnings"] for result in results)
    invalid = sum(1 for result in results if result["status"] != "valid")

    if args.json_output:
        print(json.dumps({
            "kfxlib": plugin_dir,
            "checks": {"structural": True, "deep": not args.fast,
                       "epub": not (args.fast or args.no_epub)},
            "files": results,
            "summary": {"files": len(results), "invalid": invalid,
                        "errors": total_errors, "warnings": total_warnings},
        }, indent=2, default=str))
    elif len(results) > 1:
        print("\nChecked %d files: %d valid, %d with problems (%d errors, %d warnings)" % (
            len(results), len(results) - invalid, invalid, total_errors, total_warnings))

    if any(result["status"] == "fatal" for result in results):
        return 2
    if total_errors or (args.fail_on_warnings and total_warnings):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
