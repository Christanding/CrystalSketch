# Third-party notices

CrystalSketch application code is distributed under the MIT license in LICENSE.
Third-party fonts and palette resources retain the notices below.

## Palette sources

Element themes use selected source colors with CrystalSketch-specific, fixed
element assignments and additional derived shades. These expanded element
mappings are not the original palettes and are not guaranteed to be
color-vision-safe categorical sets.

- **CARTO Pastel** is adapted from [CARTOColors by CARTO](https://github.com/CartoDB/CartoColor),
  using the [Pastel palette](https://github.com/CartoDB/CartoColor/blob/master/src/carto.ts).
  CARTOColors is licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
  Changes include fixed element assignments and additional derived shades.
- **Nord** uses the [Nord palette](https://github.com/nordtheme/nord/blob/develop/src/nord.scss).
  Copyright (c) 2016-present Sven Greb <development@svengreb.de> (https://www.svengreb.de).
  [MIT license](https://github.com/nordtheme/nord/blob/develop/license).
- **Grand Budapest 2**, **Moonrise3**, and **Royal2** use palette values from
  [wesanderson](https://github.com/karthik/wesanderson/blob/master/R/colors.R).
  Copyright (c) 2022 Karthik Ram. The source package declares
  [MIT + file LICENSE](https://github.com/karthik/wesanderson/blob/master/DESCRIPTION)
  and credits Wes Anderson Palettes for its inspiration. No film images are bundled.
- **Paul Tol Bright** uses the Bright scheme published by
  [Paul Tol](https://sronpersonalpages.nl/~pault/).
  The accompanying [Python definitions](https://sronpersonalpages.nl/~pault/data/tol_colors.py)
  identify Copyright (c) 2022, Paul Tol and the Standard 3-clause BSD license.
  CrystalSketch uses color values, not that Python implementation.
- **Rosé Pine Dawn** uses the official
  [Dawn palette](https://github.com/rose-pine/rose-pine-palette/blob/main/palette.json).
  Copyright (c) mvllow. [MIT license](https://github.com/rose-pine/rose-pine-palette/blob/main/LICENSE).
- **Tableau 10** uses the ten color values documented in
  [ggthemes](https://github.com/jrnold/ggthemes/blob/main/data-raw/theme-data/tableau.yml),
  with fixed element assignments and derived shades. The upstream R package
  [declares GPL-2](https://github.com/jrnold/ggthemes/blob/main/DESCRIPTION);
  CrystalSketch does not bundle its R implementation or depend on that package.

## MIT terms for the palette resources identified as MIT above

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## BSD 3-clause notice for Paul Tol's color definitions

Copyright (c) 2022, Paul Tol. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Fonts

LXGW WenKai and Geist Mono are distributed under their original SIL Open Font
License notices. Complete copyright and license text is in
`web/public/font-licenses.txt` in the source repository and `font-licenses.txt`
in the installer archive and bundled web assets.

## Scientific data and dependencies

Element electronegativities retain their pymatgen-core source and license
metadata in `web/src/data/electronegativity.json`. Test structure sources are
documented in `tests/fixtures/structures/SOURCE_NOTES.md`.
Python and JavaScript dependencies retain their own licenses and notices;
the project's MIT license does not replace those third-party terms.
