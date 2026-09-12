# Sound effects

These are extracted from the **Doom Sound Bulb** pack -- a 16-bit remaster of
Doom's 1993 sound effects under Doom's own lump names -- and its Extras PK3,
which adds per-monster pain and idle voices and a few sounds Doom never had.
File names are Doom's lump names in lowercase, so
<https://doomwiki.org/wiki/Sound> describes what each one is for; the Extras
follow the pack's own `SNDINFO.txt`.

The pack is a fan-made remaster of id Software's sounds. It is used here for
the game; check the pack's own terms before redistributing it or these files.

Source: `Doom_Sound_Bulb.wad` and `Doom_Sound_Bulb_Extras.pk3`, kept outside
the repository (`~Resources/Sounds/`). Rebuild with:

```bash
python tools/build_sounds.py --source "<folder holding the .wad and .pk3>" --clean
```

Only the lumps the game plays are here. The list that decides that is
`SAMPLE_NAMES` in `js/audio-system.js`, which the build tool reads; `npm test`
fails on any name there without a file, and any file here nothing plays.
