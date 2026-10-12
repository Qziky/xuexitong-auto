# 0.5.9 性能记录

# Synthetic benchmark

Run `npm.cmd run benchmark` to exercise the current recognition pipeline against a generated 30-question page and controlled OCR / vision delays. The page contains 10 single-choice, 12 blank, and 8 true/false questions with synthetic text.

The benchmark uses the current source tree only. It does not read a real platform page, use the Tesseract WASM engine, contact a model service, or compare against old Git commits. Its JSON output is written under ignored `artifacts/private/`; do not publish local reports as platform performance claims.
