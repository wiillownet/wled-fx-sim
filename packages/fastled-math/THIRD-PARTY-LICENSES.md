# Third-party licenses

This package is a TypeScript port; it redistributes no upstream source files,
but its algorithms and palette data derive from the following works.

## FastLED (MIT)

The math, easing, palette-lookup, and HSV conversion code, and the seven named
palettes (`PartyColors`, `CloudColors`, `LavaColors`, `OceanColors`,
`ForestColors`, `RainbowColors`, `RainbowStripeColors`), are derived from
FastLED 3.6.0 (https://github.com/FastLED/FastLED) as bundled by WLED v16.0.0
(`wled00/src/dependencies/fastled_slim`, "modified by @dedehai") and from the
FastLED-marked, MIT-labelled blocks of WLED's `wled00/colors.cpp` and
`wled00/palettes.cpp` ("Palettes imported from FastLED @ 3.6.0 ... are
licensed under the MIT license"). `PartyColors`, `RainbowColors`, and
`RainbowStripeColors` are WLED's `_gc22` forms: the FastLED values with an
inverse gamma of 2.2 pre-applied.

    The MIT License (MIT)

    Copyright (c) 2013 FastLED

    Permission is hereby granted, free of charge, to any person obtaining a
    copy of this software and associated documentation files (the "Software"),
    to deal in the Software without restriction, including without limitation
    the rights to use, copy, modify, merge, publish, distribute, sublicense,
    and/or sell copies of the Software, and to permit persons to whom the
    Software is furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
    THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
    FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
    DEALINGS IN THE SOFTWARE.
