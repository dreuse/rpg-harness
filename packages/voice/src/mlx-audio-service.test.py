import importlib.util
import os
import pathlib
import tempfile
import unittest
from unittest import mock

SERVICE = pathlib.Path(__file__).with_name("mlx-audio-service.py")
spec = importlib.util.spec_from_file_location("service", SERVICE)
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

VOICE = "pm_alex"
PARTNER = "pm_santa"
VALID = {"first": VOICE, "second": PARTNER, "weight": 0.3}


class ParseBlendTest(unittest.TestCase):
    def test_partner_voice_from_another_accent_is_accepted(self):
        for partner in ("af_bella", "af_sarah", "am_adam", "am_liam", "am_onyx", "bf_emma"):
            with self.subTest(partner=partner):
                self.assertEqual(
                    service.parse_blend({**VALID, "second": partner}, VOICE), (VOICE, partner, 0.3)
                )

    def test_partner_voice_is_not_a_primary_voice(self):
        self.assertIsNone(service.parse(b'{"text": "oi", "voice": "am_adam", "speed": 1}'))

    def test_every_blend_partner_is_downloaded(self):
        for partner in service.BLEND_PARTNERS:
            self.assertIn(f"voices/{partner}.safetensors", service.MODEL_FILES)

    def test_absent_blend_is_none(self):
        self.assertIsNone(service.parse_blend(None, VOICE))

    def test_valid_blend_is_returned(self):
        self.assertEqual(service.parse_blend(VALID, VOICE), (VOICE, PARTNER, 0.3))

    def test_integer_weight_is_rejected_at_bounds(self):
        for weight in (0, 1, -0.1, 1.5, True, "0.3", None):
            with self.subTest(weight=weight), self.assertRaises(ValueError):
                service.parse_blend({**VALID, "weight": weight}, VOICE)

    def test_wrong_shape_or_voices_are_rejected(self):
        bad = [
            "blend",
            [],
            {**VALID, "first": PARTNER},
            {**VALID, "second": VOICE},
            {**VALID, "second": "af_heart"},
            {"first": VOICE, "weight": 0.3},
        ]
        for blend in bad:
            with self.subTest(blend=blend), self.assertRaises(ValueError):
                service.parse_blend(blend, VOICE)


DESIGNED = "pf_luiza"
DESIGNED_BODY = ('{"text": "oi", "voice": "%s", "speed": 1}' % DESIGNED).encode()


class VoicepackTest(unittest.TestCase):
    def with_pack_dir(self, files):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for name in files:
            pathlib.Path(directory.name, name).write_bytes(b"x")
        patch = mock.patch.dict(os.environ, {service.PACK_DIR_ENV: directory.name})
        patch.start()
        self.addCleanup(patch.stop)

    def test_designed_voice_is_accepted_when_its_pack_file_exists(self):
        self.with_pack_dir([DESIGNED + ".bin"])
        parsed = service.parse(DESIGNED_BODY)
        self.assertEqual(parsed[:3], ("oi", DESIGNED, 1.0))
        self.assertIsNone(parsed[3])

    def test_designed_voice_is_rejected_without_its_pack_file(self):
        self.with_pack_dir([])
        self.assertIsNone(service.parse(DESIGNED_BODY))

    def test_designed_voice_is_rejected_without_a_pack_directory(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(service.PACK_DIR_ENV, None)
            self.assertIsNone(service.parse(DESIGNED_BODY))

    def test_ids_that_could_leave_the_pack_directory_are_rejected(self):
        self.with_pack_dir(["pf_luiza.bin", "x.bin"])
        for voice in ("../x", "pf_../x", "pf_luiza.bin", "PF_LUIZA", "pf_", "pf_luiza/../x", "", None, 7, ["pf_luiza"]):
            with self.subTest(voice=voice):
                self.assertIsNone(service.pack_path(voice))

    def test_blend_on_a_designed_voice_is_rejected(self):
        self.with_pack_dir([DESIGNED + ".bin"])
        with self.assertRaises(ValueError):
            service.parse_blend({"first": DESIGNED, "second": PARTNER, "weight": 0.3}, DESIGNED)

    def test_plain_voices_do_not_need_a_pack_directory(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(service.PACK_DIR_ENV, None)
            self.assertEqual(service.parse(b'{"text": "oi", "voice": "pm_alex", "speed": 1}')[:3], ("oi", "pm_alex", 1.0))


if __name__ == "__main__":
    unittest.main()
