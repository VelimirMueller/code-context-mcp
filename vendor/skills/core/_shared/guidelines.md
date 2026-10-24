# Guidelines

Rules for web interface work: a MUST core, then the details.
Distilled from the book *Roots of UI/UX Design* (2024). A project design system wins.

## MUST — the non-negotiable core

- Body text is 16px (1rem) or larger. Never smaller.
- Text/background contrast meets WCAG AA (4.5:1 body, 3:1 large text). Measure it; do not guess.
- No pure black on white and no white on pure black — use dark gray instead (halation, astigmatism).
- Touch targets are at least 44px (mobile) / 40px (desktop); keep 8-10px between targets.
- Every interactive element ships all states: default, hover, active, focus, progress (async), disabled.
- One icon style per project, from one pack. Never mix styles.
- At most 3 font sizes per screen section; all sizes come from one type scale.
- Buttons keep one radius, one type style, one shadow logic across primary/secondary/tertiary.
- Forward action sits right, back sits left; swap them only to deter destructive actions.
- Error messages say what went wrong and how to fix it. Never a bare "invalid input".
- Navigation shows the primary pages first; mobile bottom tabs hold at most 5 items.
- Every view has four states designed, not discovered: empty, loading, error, content. A view that designs only the happy path breaks on the first real user.
- Every interactive element is keyboard-reachable and operable: logical tab order, a visible focus ring, Enter/Space for buttons, arrows for menus.
- Colour is never the only signal — state, status and links pair colour with a shape, icon or text.

## Layout and grid

- 12-column grid is the standard; never 7, 9, or 11 columns (poor divisibility).
- Fluid grid (columns adapt, gutters/margins fixed) for responsive layouts; fixed grid only for content that never reflows.
- 8pt system: element dimensions are multiples of 8 (16, 24, 32, 40 …); text sits on a 4px baseline grid.
- Desktop: gutters 12-16pt, margins 160-180pt. Mobile: 8pt grid, margins 16px (20-24px common), gutters 16px — 8px only in tight layouts.
- Align adjacent text blocks on the baseline of their first lines.
- Whitespace is structure: margins give content room to breathe; cramped spacing hides links and actions.

*The 8pt grid forgives almost everything. Your arbitrary 13px forgives nothing.*

## Typography

- Typeface is the family; fonts are its weights. Pick a family for legibility, scalability, and weight range.
- Sans-serif is the UI default; serif reads classic; script is decoration only, never primary text.
- Line height ~1.6 × size for body text; closer for large headings (inverse rule).
- Keep line length balanced: too long loses the reader's return path, too short breaks rhythm.
- Letter spacing stays 0 unless all-caps needs air (kerning); trust good fonts and Material/Apple defaults.
- Left-align body text; center only short passages. Watch the rag (uneven edge) — an even rag reads smoothly.
- Hero title: one H1 of at most 10 words; description in H5/H6; one clear hierarchy per page.
- The 3-size limit counts per section, not per project: one heading, one body, one caption size (for example H2 + 16px body + 13px caption). The full type scale spans the whole product.

*Why did the font go to therapy? Too many issues with its family - and its weights.*

## Color

- Formats: HEX/RGB for screens, CMYK print, Pantone brand. Hue = pure color; tints add white, shades add black.
- Build the palette in 5 steps: primary → secondary (complement or neutral) → attention colors (alerts, notifications) → tints/shades → apply 60-30-10 (dominant neutral 60, secondary 30, accent 10).
- Harmony schemes: complementary (loud), analogous (calm, one dominant + two accents), split-complementary, triadic (bold), rectangular, monochromatic (subtle).
- Semantic colors: blue = info, green = success, yellow = warning, red = danger/error. Use them for meaning, not decoration.
- Dark mode: tints create more contrast than shades; never use white shadows — pair a darker shade of the element with a lighter tint of the background.
- Nature is a safe reference for palettes and gradients; familiar hues read comfortable.

## Gradients and shadows

- Gradient types: linear (lightest color on top — light comes from above), radial (3D feel, round shapes), angular/conic.
- Small shapes: at most 3 colors, symmetric stops. Primary color + own tints/shades is the safe range; complementary pairs need a bridging color or they turn muddy grey.
- Shadows: none = on the surface, drop = raised, inner = embedded (inputs, neumorphism).
- Realism = core shadow (tight, dark, close) + cast shadow (wide, light, far) — two layers, not one; shadow size grows with the element.
- Never place a shadow above an element (light does not come from below).
- Shadows carry meaning: hierarchy on the z-axis, depth, movement, surface edges.

## Buttons

- Base size: 16px label, 12px vertical padding; width ≈ 2 × height; sizes XS-XL establish hierarchy.
- Touch targets: the MUST rule (44px mobile, 40px desktop) is canonical. Material 36px and Apple 40px are the platform-historical minimums; the MUST rule already covers them.
- Rounded corners lower cognitive load and pull attention to the label; square or softly rounded are the norms.
- Roles: primary = the one main action, secondary = alternatives, tertiary = low impact; when options are equal, no hierarchy.
- Place buttons along F-pattern (text-heavy pages) and Z-pattern (scannable pages); where users expect them, or color/size cannot compensate.
- Toggles: no "ON/OFF" text inside — color marks the active state.
*A button without a hover state is a doorbell without a chime.*

## Forms and inputs

- Use the right input type (text, email, number …) to cut errors; placeholders show the expected format; icons in fields add intuition.
- Inputs change look by state and answer with feedback: error text with a fix, success icon when valid.
- Match input width to the expected content (zip vs address).
- Dropdowns for more than 4 options: chevron, search for long lists, scrollbar, categories or dividers.
- Radio = one of mutually exclusive options; checkbox = any number of independent options; touch area ≥ 48px on mobile.
- Long forms split into categorized steps (wizard): 2-10 steps, numbered progress, plain "previous"/"next" labels, next unlocks only when the step is complete.
*An error message that gives no fix is a shrug in a tooltip.*

## Icons

- Styles: outline, glyph, duo-tone are the workhorses; gradient and glass sparingly (fatigue); 3D only large.
- Three jobs: clarify text, trigger actions, decorate. An icon users must decode has failed.
- Simple shapes, one frame per set (16/24/32px), scale inside the frame; ≤ 3-4 colors; uniform line widths matching text weight; rounded corners help again.
- Sources: heroicons, icons8, materialdesignicons, nucleo.
*If an icon needs a caption, it is not an icon. It is a very small poster.*

## Images and illustrations

- Images need one clear focal point, compression before upload, and testing across screen sizes — "hard to read on a small screen" means wrong image.
- One visual style everywhere (mood board); stock from matching collections; context and emotion must fit the brand; human, warm imagery wins over harsh or cold.
- Text on images needs a filter/overlay at 50-80% opacity; give the composition air (open images) and keep the message concise.
- Rule of thirds: place the subject on the grid lines or intersections, not dead center.
- Illustrations act in 1/10 second; keep details visible (no shrinking into corners), keep one character/style across scenes; prefer real photos when users must see the real product.
- Illustration spots: hero, onboarding, empty states, error pages. Sources: iradesign, blush, drawkit.

## Navigation

- Menus: header (primary, dropdown arrow signals sub-levels), sidebar (dashboards, admin), footer (resources, policies, contact, social).
- Breadcrumbs from 3+ pages deep, current page clearly highlighted.
- Desktop tabs switch context without navigation; mobile bottom tabs = top-level screens, ≤ 5.
- Keep navigation consistent, uncluttered, responsive; icons in navbars use tint or 50-60% opacity, never the text color; navbar radius > 8px matches its buttons.

### Sidebar

- Separate the two jobs: high-frequency navigation (resume work, switch view) sits in the top zone; low-frequency configuration (settings, integrations) sits in a bottom zone or a collapsed "more" group. Mixing them flattens the hierarchy.
- Group the primary list by recency (Today / Yesterday / This week) with sticky headers. A flat unsorted list fails the ten-second scan.
- Mark exactly one item current with a filled or tinted row, not a checkmark alone; a colour-only mark fails colour-blind users, so pair it with a shape or label.
- A collapse toggle remembers its state per project or per user. A sidebar that resets to full width on every launch fights the user.
- Rows honour the MUST targets (40px) and AA contrast; truncate long titles with a tooltip, never silent clipping.
- Put search or a quick-switch (Cmd-K) above the list; power users navigate by keyboard, so arrow keys and Enter must move and open.
- Badges show count and colour, never colour alone; hide a badge at zero instead of showing "0".
- The first-run list is never blank: an empty state with one clear action beats an empty panel.
- Collapse/expand animation respects `prefers-reduced-motion`.

## Mobile

- ~54% of traffic is mobile — mobile-first is the default posture.
- Thumb zones decide placement: primary actions where a thumb rests; controls native to touch, not repurposed web widgets.
- Larger text, simplified forms (minimum typing), clear hierarchy on small screens, consistent look across web and app.

## Page recipes (structure starting points)

- About: hero + logo wall + features + team (real faces) + stats.
- Blog post: clean hero, strong content hierarchy, author box with socials, related articles.
- Product: name/price/stock + delivery & refund facts + reviews + related products.
- Sign up/in: classic form + social OAuth, real-time validation, remember-me, prominent submit, links to the counterpart page.
- Legal: anchor menu with scrollspy (section highlight) over long text.
- Chat: grouped history with timestamps + search.
- Admin: charts for overview, tables with sort/filter/pagination for detail, project cards with deadlines.

## States (empty, loading, error, progress)

- Empty: one short headline plus one clear action. An illustration helps, but the action is the point.
- Loading: skeletons match the final layout's shape and size (not a single spinner); a spinner is for waits under ~1s, a skeleton or progress bar for longer.
- Error: name what went wrong and give the fix or a retry. Never a bare error code or "something went wrong".
- Progress: an async trigger shows a state on itself (disabled + spinner), then a result (success) or a fixable failure. A button that does nothing for two seconds looks broken.

## Accessibility

- Semantics over sight: labelled controls, one H1 per page, alt text that states the image's job. Screen readers read the DOM, not the pixels.
- Motion respects `prefers-reduced-motion`; a user who asked for less motion gets none.
- The MUST core's contrast and touch-target rules are accessibility rules, not decoration.

## Working with an existing design system

- The repo wins: read the project CLAUDE.md, its design-system docs, and its skeleton (for example a PLAT-style base) before applying this reference.
- Values come from the token layer — CSS variables, Tailwind config, theme files — never raw hex or magic px where a token exists. New values join the token layer on the 8pt scale.
- Style through the project styling system (utility or component classes); an inline style attribute is a defect, not a shortcut.

## Process

- UX ground rules: intuitive and self-explanatory; solves the user's real problem; accessible to a diverse audience; frustration-free.
- CUBI model (Corey Stern): Content, User goals, Business goals, Interactions — content shapes the experience in every phase, not just at the end.
- AI assists: font pairing, palette and contrast drafting, WCAG checks, button labels — assist, verify, then decide.
