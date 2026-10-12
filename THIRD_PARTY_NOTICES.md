# Third-party notices

The following components and data are included in the browser extension distribution. Their license identifiers were checked against the package metadata in `package-lock.json`.

| Component | Version | License | Distribution role |
| --- | --- | --- | --- |
| React | 19.3.0 | MIT | Extension interface |
| React DOM | 19.3.0 | MIT | Extension interface |
| Tesseract.js | 7.0.0 | Apache-2.0 | Local OCR runtime |
| Tesseract.js core | 7.0.0 | Apache-2.0 | OCR workers and WASM runtime |
| `@tesseract.js-data/chi_sim` | 1.0.0 | MIT | Simplified Chinese OCR data |
| `@tesseract.js-data/eng` | 1.0.0 | MIT | English OCR data |

The build copies the upstream license files for the OCR runtime and language data into the generated extension where provided. The source ZIP also includes this notice and the project license. Development-only dependencies are listed in `package.json` and `package-lock.json`; they are not intentionally bundled as runtime extension packages.
