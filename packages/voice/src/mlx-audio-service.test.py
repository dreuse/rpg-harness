import importlib.util
import pathlib
import unittest

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


if __name__ == "__main__":
    unittest.main()
