# Brand assets

| File | What it is |
| --- | --- |
| `memorylane-icon.png` | Master app icon, 1024×1024, transparent outside the rounded tile. Source for every app icon size. |
| `memorylane-icon-256.png` | README / docs copy. |
| `tray.svg`, `tray-paused.svg` | Tray glyphs (32×32 viewBox): the icon's wave filmstrip without the tile, plus a greyed paused variant with a pause badge. |

## Regenerating

App icons (`src-tauri/icons/`):

```bash
npx tauri icon assets/brand/memorylane-icon.png
```

The tile leaves about 5% padding around the canvas. That's fine at large sizes, but it wastes pixels
at 16–32 px. So `icon.ico` and `icons/32x32.png` are then rebuilt with the 16, 20, 24 and 32 px
entries cropped tight to the tile, and 40 px and up from the full image. Re-do that crop after
running `tauri icon`, or the small sizes will look slightly smaller.

Tray icons (`src-tauri/icons/tray.png`, `tray-paused.png`, embedded by `setup_tray`):

```bash
npx tauri icon assets/brand/tray.svg -o tmp-tray -p 32
```

Copy `tmp-tray/32x32.png` to `src-tauri/icons/tray.png`. Repeat for `tray-paused.svg`.

UI copies in `public/` (`memorylane-icon-64.png` for the sidebar and favicon, `-256` for the landing
page touch icon) are tight-cropped downscales of the master.

## Palette

Tile `#efe3cc` · strip `#c4602a` · frames `#e8b04f`. Paused tray: `#7a7a7a` / `#b8b8b8`.
