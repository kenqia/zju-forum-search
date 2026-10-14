import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import release


class ReleaseArtifactsTest(unittest.TestCase):
    def test_relay_archive_excludes_other_build_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'relay/dist').mkdir(parents=True)
            for name in (*release.RELAY_FILES, 'relay/dist/manifest.json'):
                (root / name).write_text('{}')
            archive = root / 'relay.zip'
            release.write_archive(archive, [(root / name, name) for name in release.RELAY_FILES])
            release.verify_archive(archive, release.RELAY_FILES)
            with zipfile.ZipFile(archive) as zipped:
                self.assertNotIn('relay/dist/manifest.json', zipped.namelist())

    def test_extension_rejects_unexpected_entries_and_wrong_version(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'extension.zip'
            names = [f'dist/{name}' for name in release.EXTENSION_FILES]
            with zipfile.ZipFile(archive, 'w') as zipped:
                for name in names:
                    zipped.writestr(name, json.dumps({'version': '0.3.4'}))
            release.verify_archive(archive, names, '0.3.4')
            with self.assertRaisesRegex(ValueError, 'version mismatch'):
                release.verify_archive(archive, names, '0.3.5')
            with zipfile.ZipFile(archive, 'a') as zipped:
                zipped.writestr('unexpected.txt', 'synthetic')
            with self.assertRaisesRegex(ValueError, 'unexpected ZIP contents'):
                release.verify_archive(archive, names, '0.3.4')

    def test_prepare_rejects_dirty_tree_before_building(self):
        with patch.object(release, 'command', return_value=' M tracked-file'), \
                patch.object(release.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'working-tree changes'):
                release.prepare()
            run.assert_not_called()

    def test_published_release_rejects_short_sha_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata = Path(directory) / 'release.json'
            metadata.write_text(json.dumps({'repository': release.REPOSITORY, 'tag': 'v0.3.4',
                                            'version': '0.3.4', 'commit': '113dd75'}))
            with patch.object(release, 'command') as command:
                with self.assertRaisesRegex(ValueError, 'full commit SHA'):
                    release.verify_published(metadata)
                command.assert_not_called()

    def test_published_release_rejects_replaced_download(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata = Path(directory) / 'release.json'
            asset = 'zju-forum-search-v0.3.4.zip'
            commit = 'a' * 40
            metadata.write_text(json.dumps({'repository': release.REPOSITORY, 'tag': 'v0.3.4',
                'version': '0.3.4', 'commit': commit,
                'extension': {'name': asset, 'sha256': '0' * 64}}))
            published = json.dumps({'isDraft': False, 'tagName': 'v0.3.4',
                                    'name': 'v0.3.4 · test', 'assets': [{'name': asset}]})

            def download(args, **_kwargs):
                target = Path(args[args.index('--dir') + 1]) / asset
                target.write_bytes(b'replaced synthetic archive')

            with patch.object(release, 'command', side_effect=[published, commit]), \
                    patch.object(release.subprocess, 'run', side_effect=download):
                with self.assertRaisesRegex(ValueError, 'SHA-256'):
                    release.verify_published(metadata)
