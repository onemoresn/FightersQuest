Fighter's Quest — Stats Screen (Prototype)

This is a small static prototype that renders a character "Stats" screen similar to the provided design and demonstrates how daily/weekly task requirements scale with level.

Files:
- `index.html` — main UI
- `styles.css` — visual styles
- `app.js` — UI state + interactivity (level controls and scaling)

How to run:
- Open `index.html` in your browser (double-click or right-click -> Open With).

Notes on scaling:
- Daily/weekly requirements scale linearly in this prototype using: `requirement = base + floor((level-1) * 1.5)`
- This is a simple demo formula — we can change it to any progression (linear, exponential, tiered per 5 levels, etc.).

New features added:
- Task checkboxes: complete dailies/weeklies to earn XP.
- XP & leveling: completing tasks grants XP; leveling increases stats and XP-to-next-level.
- Persistence: progress (tasks, XP, level) is saved to `localStorage`.
- Tiered scaling: daily/weekly requirements now scale by 10% per 5-level tier.

Resetting:
- Use the `Reset Day` button to clear the daily completion.
- Use the `Reset Week` button to clear weekly completions.

Customization:
- Adjust XP rewards in `app.js` in `toggleTask` event wiring.
- Change tier scaling or XP formulas in `app.js` (`tieredRequirement` and `xpToLevelUp`).

Next steps I can take if you'd like:
- Persist user data (localStorage) and add XP mechanics.
- Add daily/weekly task checkboxes and track completion + XP rewards.
- Add authentication or a small backend to save user profiles.
 
New: Navigation, Challenges, Quests
- A bottom navigation now switches between `Stats`, `Challenges`, and `Quests` screens.
- `Challenges` contains predefined fitness challenges (50/100/150 push-ups, 50/100 sit-ups). Completing a challenge awards XP.
- `Quests` shows simple opponents with power levels; pressing `Fight` runs a short battle simulation and awards XP on victory.

All progress (completed challenges, XP, level) is saved to `localStorage`.
