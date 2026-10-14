"""Prepare local release artifacts or verify a published extension asset."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
EXTENSION_FILES = ('background.js', 'cc98-webvpn-bridge.js', 'content.js', 'manifest.json')
RELAY_FILES = ('relay/dist/index.js', 'relay/package.json')
REPOSITORY = 'kenqia/zju-forum-search'


def command(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def version_from(manifest):
    version = json.loads(manifest.read_text())['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('manifest version must have three numeric components')
    return version


def write_archive(path, files):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for source, name in files:
            archive.write(source, name)


def verify_archive(path, expected_names, version=None):
    with zipfile.ZipFile(path) as archive:
        if sorted(archive.namelist()) != sorted(expected_names):
            raise ValueError(f'{path.name}: unexpected ZIP contents')
        if archive.testzip() is not None:
            raise ValueError(f'{path.name}: corrupt ZIP entry')
        if version and json.loads(archive.read('dist/manifest.json'))['version'] != version:
            raise ValueError(f'{path.name}: manifest version mismatch')


def prepare():
    if command('git', 'status', '--porcelain'):
        raise ValueError('commit or isolate working-tree changes before preparing a release')
    commit = command('git', 'rev-parse', 'HEAD')
    subprocess.run(['npm', 'run', 'check'], cwd=ROOT / 'frontend', check=True)
    if command('git', 'status', '--porcelain') or command('git', 'rev-parse', 'HEAD') != commit:
        raise ValueError('source changed during release checks; prepare again from a clean commit')
    version = version_from(ROOT / 'frontend/public/manifest.json')
    if version_from(ROOT / 'frontend/dist/manifest.json') != version:
        raise ValueError('built manifest does not match source version')
    output = ROOT / 'dist/releases' / f'v{version}'
    output.mkdir(parents=True, exist_ok=True)
    extension = output / f'zju-forum-search-v{version}.zip'
    relay = output / f'zju-forum-search-relay-v{version}.zip'
    write_archive(extension, [(ROOT / 'frontend/dist' / name, f'dist/{name}') for name in EXTENSION_FILES])
    write_archive(relay, [(ROOT / name, name) for name in RELAY_FILES])
    verify_archive(extension, [f'dist/{name}' for name in EXTENSION_FILES], version)
    verify_archive(relay, RELAY_FILES)
    metadata = {
        'repository': REPOSITORY, 'tag': f'v{version}', 'version': version, 'commit': commit,
        'extension': {'name': extension.name, 'sha256': digest(extension)},
        'relay': {'name': relay.name, 'sha256': digest(relay)},
    }
    (output / 'release.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(f'Release artifacts: {output}\nTarget commit: {commit}')


def verify_published(metadata_path):
    metadata = json.loads(metadata_path.read_text())
    repo, tag, version = metadata['repository'], metadata['tag'], metadata['version']
    if tag != f'v{version}' or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('invalid release tag or version')
    commit = metadata['commit']
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('release target must be a full commit SHA')
    release = json.loads(command('gh', 'release', 'view', tag, '--repo', repo,
                                 '--json', 'isDraft,tagName,name,assets'))
    if release['isDraft'] or release['tagName'] != tag or not re.match(rf'^{re.escape(tag)}(?:\s|$)', release['name']):
        raise ValueError('release is draft or its tag/title does not match')
    if command('gh', 'api', f'repos/{repo}/commits/{tag}', '--jq', '.sha') != commit:
        raise ValueError('published tag does not point to the prepared commit')
    asset = metadata['extension']
    if asset['name'] != f'zju-forum-search-{tag}.zip':
        raise ValueError('extension asset name does not match version')
    if not any(item['name'] == asset['name'] for item in release['assets']):
        raise ValueError('extension asset is missing')
    with tempfile.TemporaryDirectory(prefix='zju-release-verify-') as directory:
        subprocess.run(['gh', 'release', 'download', tag, '--repo', repo,
                        '--pattern', asset['name'], '--dir', directory], check=True)
        archive = Path(directory) / asset['name']
        if digest(archive) != asset['sha256']:
            raise ValueError('downloaded extension SHA-256 does not match prepared artifact')
        verify_archive(archive, [f'dist/{name}' for name in EXTENSION_FILES], version)
    print(f'{tag}: published commit, title, asset, SHA-256 and ZIP contents verified')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest='action', required=True)
    subcommands.add_parser('prepare')
    verify = subcommands.add_parser('verify')
    verify.add_argument('metadata', type=Path)
    args = parser.parse_args()
    if args.action == 'prepare':
        prepare()
    else:
        verify_published(args.metadata)
