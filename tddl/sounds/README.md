# Sound effects

These come from **Doom Sound Bulb** by SoundBulb -- a high-quality remaster of
Doom's 1993 sound effects and the successor to Per Kristian's Doom sound pack,
from the ModDB re-upload (<https://www.moddb.com/games/doom/addons/doom-sound-bulb-re-uploaded>) -- extracted from its WAD, under Doom's own
lump names, and its Extras PK3,
which adds per-monster pain and idle voices and a few sounds Doom never had.
Entry names are Doom's lump names in lowercase, so
<https://doomwiki.org/wiki/Sound> describes what each one is for; the Extras
follow the pack's own `SNDINFO.txt`.

What is committed here is `sounds.pak`: every sound the game plays, bundled
and scrambled by `tools/pack_assets.py` (see "Assets" in the top-level
README). The individual `.wav` files the build tool writes into this folder
are git-ignored and are the packer's input; they are not in the repository.
The scrambling only discourages casual extraction.

These sounds, packed or not, are not covered by the project's GPL licence; see
[`NOTICE.md`](../NOTICE.md).

Source: `Doom_Sound_Bulb.wad` and `Doom_Sound_Bulb_Extras.pk3`, kept outside
the repository (`~Resources/Sounds/`). Rebuild with:

```bash
python tools/build_sounds.py --source "<folder holding the .wad and .pk3>" --clean
```

That writes the `.wav` files and then rebuilds `sounds.pak` from them; to
repack without re-extracting, run `python tools/pack_assets.py sounds`.

Only the lumps the game plays are packed. The list that decides that is
`SAMPLE_NAMES` in `js/audio-system.js`, which the build tool reads; `npm test`
fails on any name there missing from the pack, and anything in the pack
nothing plays.
