"""Dataset/metric guards independent of GPU/model downloads."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("vivic_startlux_training", Path(__file__).with_name("startlux.py"))
training = importlib.util.module_from_spec(spec)
spec.loader.exec_module(training)


class TrainingDataTests(unittest.TestCase):
    def setUp(self):
        self.rows = training.read_data(training.ROOT / "training/startlux/vivic-intents.jsonl")

    def read_mutation(self, mutate):
        mutate(self.rows)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "data.jsonl"
            file.write_text("\n".join(json.dumps(row) for row in self.rows), encoding="utf-8")
            return training.read_data(file)

    def test_all_splits_cover_seven_classes_and_real_heldout_is_not_used_for_steps(self):
        self.assertEqual(len(self.rows), 90)
        self.assertEqual({row["split"] for row in self.rows}, {"train", "validation", "test"})
        self.assertEqual(sum(row["split"] == "test" for row in self.rows), 20)

    def test_duplicate_text_cannot_leak_across_splits(self):
        def mutate(rows):
            rows[-1]["utterance"] = rows[0]["utterance"]
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.read_mutation(mutate)

    def test_paraphrase_family_cannot_cross_splits(self):
        def mutate(rows):
            rows[-1]["group"] = rows[0]["group"]
        with self.assertRaisesRegex(ValueError, "crosses"):
            self.read_mutation(mutate)

    def test_metrics_keep_raw_false_accepts_visible(self):
        common = {"confidence": .9, "brier": .1, "candidate_accepted": True}
        result = training.metrics([{**common, "gold": "other", "prediction": "fit"},
                                   {**common, "gold": "fit", "prediction": "fit"}])
        self.assertEqual(result["accuracy"], .5)
        self.assertEqual(result["raw_model_candidate_false_accepts"], 1)
        self.assertEqual(result["other_recall"], 0)
        self.assertGreater(result["ece_5bins"], 0)


if __name__ == "__main__":
    unittest.main()
