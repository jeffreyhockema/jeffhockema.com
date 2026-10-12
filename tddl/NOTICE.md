# Notices and credits

## TDDL

Copyright (C) 2026 Jeff Hockema

TDDL is free software; you can redistribute it and/or modify it under the terms
of the GNU General Public License as published by the Free Software Foundation;
either version 2 of the License, or (at your option) any later version.

TDDL is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
this program, in the file [`LICENSE`](LICENSE). If not, see
<https://www.gnu.org/licenses/>.

SPDX-License-Identifier: GPL-2.0-or-later

Source code: <https://github.com/jeffreyhockema/TDDL>

### What the license covers

The GPL covers this project's own work:

- all source code: `index.html`, everything in `js/`, `test/` and `tools/`
- art the game draws in code, such as the status bar's marine face (`js/hud.js`)
  and the armour pickups (`js/weapons.js`)
- the recolourings, repaints and atlas layouts made by the build tools in
  `tools/`, to the extent they are this project's own work. They do not
  change the licence of the artwork they are made from; see below.
- the documentation

### Portions from the DOOM source code

Parts of the game are ported from id Software's source code for *DOOM*,
which id released under the GNU General Public License, version 2:

- the monster AI in `js/entities.js` and `js/monsters.js`, a port of the
  monster half of `p_enemy.c`: looking for and waking to the player
  (`P_LookForPlayers`, `P_NoiseAlert`, `A_Look`), eight-direction chasing
  (`P_NewChaseDir`, `P_Move`, `A_Chase`), the missile-range roll
  (`P_CheckMissileRange`), pain, infighting, and the monsters' own attacks
  (the Arch-vile's, the Pain Elemental's, the Lost Soul's and others)
- the monster table in `js/monsters.js`: hit points, speeds, sizes, reaction
  times and pain chances from `info.c`
- the weapons' damage dice and spread, after `p_pspr.c`
- the cheat replies in `js/cheats.js`, taken word for word from `d_englsh.h`
- the damage and power-up rules after `p_inter.c`, such as armour absorption
  (`P_DamageMobj`) and the power-up names and durations

Those portions are Copyright (C) 1993-1996 id Software, Inc., and are used under
the GNU General Public License, version 2. id's release states version 2 and
does not say "or any later version", so the game as a whole, with those
portions in it, is distributed under GPL version 2. This project's own code is
also available under any later version, as above.

The original source is at <https://github.com/id-Software/DOOM>.

### What it does not cover

The following are not covered by the GPL. They remain the property of their
respective owners.

| Path | What it is | Owner |
|------|------------|-------|
| `sprites/logo.png` | The TDDL logo | Jeff Hockema, all rights reserved |
| `sounds/sounds.pak` | Sound effects | See below |
| `sprites/enemies.pak`, `sprites/enemies-extra.pak` | Monster sprites | CraftPix, see below |
| `sprites/player.pak` | Player sprites | CraftPix, see below |
| `sprites/items.pak` | Pickup icons | CraftPix, see below |

The `.pak` files are asset packs: they contain these same third-party sound
effects, sprites and icons, bundled and scrambled by `tools/pack_assets.py`.
Packing them does not change who owns them or the terms they are used under.
The loose files the build tools write in a working copy (`sounds/*.wav`,
`sprites/enemies/*.png`, `sprites/player/*.png`, `sprites/items/*.png`) are the
same assets and are not part of this repository.

## Third-party assets

### Sound effects

The sound effects come from **Doom Sound Bulb** by SoundBulb, a high-quality
remaster of the sound effects of id Software's *DOOM* (1993) and the successor
to Per Kristian's Doom sound pack
(<https://www.perkristian.net/game_doom-sfx.shtml>). They were taken from the
re-upload by Kalashnikov47 on ModDB (<https://www.moddb.com/games/doom/addons/doom-sound-bulb-re-uploaded>), which lists it under a Creative
Commons licence. `tools/build_sounds.py` extracts them from the mod's
`Doom_Sound_Bulb.wad` and `Doom_Sound_Bulb_Extras.pk3`, and
`tools/pack_assets.py` packs them into `sounds/sounds.pak`. Copyright remains
with their respective owners.

### Sprites and icons: CraftPix

The character sprites and pickup icons are built from **CraftPix** assets
(<https://craftpix.net>) by the tools in `tools/`, which crop, recolour and pack
them into atlases, which `tools/pack_assets.py` then bundles into the
`sprites/*.pak` asset packs. They are used under the CraftPix licence
(<https://craftpix.net/file-licenses/>).

Player (`sprites/player.pak`) and pickup icons (`sprites/items.pak`):

- Zombie TDS: main characters and items (craftpix-722561)

Monsters (`sprites/enemies.pak` and `sprites/enemies-extra.pak`):

| CraftPix pack | Characters built from it |
|---------------|--------------------------|
| Free Tribal Warrior Boss Characters Asset Pack (176111) | aztec-leader, maya-leader, nordic-leader |
| Top-Down Fantasy Boss Characters Pack 2: Yeti, Ogre, Cyclops (191083) | armored-ogre, cyclops, yeti |
| Tribal 4-Direction Character Sprite Asset Pack (197730) | aztec, maya, nordic |
| Free Medieval Bandit 4-Direction Character Pack (218811) | assassin, robber, thug; shotgun-guy and zombieman |
| Free Top-Down Goblin Character Sprite (228980) | chief-goblin, female-goblin, male-goblin; imp |
| Top-Down Skeleton Characters Pack: Wizard, Knight, Archer (229181) | skeleton-archer, skeleton-knight, skeleton-wizard |
| Mythology 2D Character Assets: Anubis, Medusa, Horus (270646) | anubis, horus, medusa; arch-vile and pain-elemental |
| Top-Down Boss Characters Pack 3: Rock, Earth, Ice Monsters (545831) | earth-monster, ice-monster, rock-monster; demon and mancubus |
| Top-Down Pirate 2D Character Pack (630832) | pirate-captain, pirate-guy, pirate-skeleton; lost-soul |
| Fantasy Archer Top-Down Characters Pack (807914) | female-archer, goblin-archer, male-archer |
| Free Top-Down Boss Character 4-Direction Pack (907874) | caveman-boss, giant-goblin, viking-leader; baron, chaingunner and hell-knight |
| Fantasy Top-Down Mushroom Character Asset Pack (933216) | mushroom-head-archer, mushroom-head-knight, mushroom-head-wizard |
| Ancient Mythology Boss Characters Top-Down Asset Pack (947906) | minotaur, pharaoh, zeus |
| Top-Down Wizard Characters Pack: Male, Veteran, Female (954187) | wizard-female, wizard-male, wizard-veteran |

The Doom-named monsters (imp, demon, baron and the rest) are recoloured
versions of the pack characters listed beside them, made by
`tools/build_doom_monsters.py`.

## Loaded at run time, not included

The page loads these from their own servers; none of their files are in this
repository.

- **Press Start 2P** by CodeMan38, copyright 2012 The Press Start 2P Project
  Authors, with Reserved Font Name "Press Start 2P". SIL Open Font License 1.1.
  Served by Google Fonts.
- **Oxanium** by Severin Meyer, copyright 2019 The Oxanium Project Authors
  (<https://github.com/sevmeyer/oxanium>). SIL Open Font License 1.1. Served by
  Google Fonts.
- **Tailwind CSS**, copyright Tailwind Labs, Inc. MIT License. Served from
  `cdn.tailwindcss.com`.

## Trademarks

DOOM is a registered trademark of id Software LLC, a ZeniMax Media company.
TDDL is an unofficial fan project. It is not affiliated with, endorsed by or
sponsored by id Software, ZeniMax Media, Bethesda Softworks or Microsoft. The
game's rules, monster names and cheat codes follow *DOOM* as a tribute to it.
The only code of id Software's in it is the GPL-licensed portions listed
above. The *Doom Wiki* (<https://doomwiki.org>) was the reference for how Doom
behaves.
