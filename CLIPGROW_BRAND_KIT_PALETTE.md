# ClipGrow — Brand Identity & Color Palette Kit

This specification contains the official color palette, UI surface hierarchy, functional accent colors, and typography rules for **ClipGrow**. Share this file directly with your designer or agency for building the brand kit, vector assets, and design system.

---

## 1. Primary Brand Identity

The ClipGrow brand aesthetic is a high-energy **Cyber/Growth Dark Mode** anchored by high-contrast neon green on obsidian green-black surfaces.

| Swatch | Color Name | HEX | RGB | HSL | Semantic Role |
|:---:|:---|:---:|:---:|:---:|:---|
| ?? | **ClipGrow Neon Green** (Primary) | `#3DFF7A` | `rgb(61, 255, 122)` | `hsl(138, 100%, 62%)` | Primary CTA, brand logo accent ("Grow"), active indicators, pulsing badges |
| ?? | **Neon Dark** (Hover / Active) | `#2CC760` | `rgb(44, 199, 96)` | `hsl(140, 64%, 48%)` | Button hover/pressed state, active border highlight, secondary brand accent |
| ?? | **Neon Glow (Strong)** | `rgba(61, 255, 122, 0.22)` | `rgba(61, 255, 122, 0.22)` | — | Outer glow, box shadows (`0 4px 20px`), button luminescence |
| ? | **Neon Glow (Subtle)** | `rgba(61, 255, 122, 0.12)` | `rgba(61, 255, 122, 0.12)` | — | Active tab fills, card ambient highlight, pill selection tint |

> **Logo Construction:**
> - Wordmark: **Clip** (`#F0F5F0`) + **Grow** (`#3DFF7A`)
> - Font: `Space Grotesk` (Weight: 800 ExtraBold)

---

## 2. Surface & Background Hierarchy (Dark Canvas)

ClipGrow uses a tiered dark palette infused with an ultra-subtle deep green undertone (rather than cold neutral gray), creating depth and continuity.

| Layer | Name | HEX | RGB | Use Case |
|:---|:---|:---:|:---:|:---|
| **Base** | Canvas Background | `#080D08` | `rgb(8, 13, 8)` | Main page background canvas, full-screen background |
| **Layer 1** | Background Mid | `#0B120B` | `rgb(11, 18, 11)` | Sidebars, modal backing, nested dark panels |
| **Layer 2** | Card Surface | `#0F170F` | `rgb(15, 23, 15)` | Primary cards, content boxes, table containers, popups |
| **Layer 3** | Card Hover / Elevated | `#141E14` | `rgb(20, 30, 20)` | Hover state on cards, metric stat cards, elevated badges |

---

## 3. Borders & Dividers

Borders define structural boundaries in dark mode without relying on heavy shadows.

| Token | Name | HEX | RGB | Use Case |
|:---|:---|:---:|:---:|:---|
| `--border` | Structural Border | `#1A2C1A` | `rgb(26, 44, 26)` | Card outlines, header dividers, sidebar right border |
| `--border-s` | Subtle Border | `#223322` | `rgb(34, 51, 34)` | Table row dividers, input field borders, pill borders |

---

## 4. Typography Colors (Hierarchy)

| Role | HEX | RGB | Use Case |
|:---|:---:|:---:|:---|
| **Headings / High Contrast** | `#F0F5F0` | `rgb(240, 245, 240)` | `h1` through `h4`, hero copy, primary titles, button hover text |
| **Body Text** | `#C4D4C4` | `rgb(196, 212, 196)` | Primary body copy, table data, description text, input values |
| **Muted Light** | `#849484` | `rgb(132, 148, 132)` | Secondary metadata, table column headers, form labels, timestamps |
| **Muted Dark** | `#566056` | `rgb(86, 96, 86)` | Footers, subtle hints, placeholder text, inactive icons |

---

## 5. Functional & Feedback Accents

Used across dashboards, application statuses, and payout states:

| Color | HEX | RGB | Semantic Role |
|:---|:---:|:---:|:---|
| **Alert Red** | `#FF4D4D` | `rgb(255, 77, 77)` | Rejections, disqualified clips, error notices, ?? account flags |
| **Gold / Warning** | `#FFD700` | `rgb(255, 215, 0)` | Pending reviews, warning badges, high-attention counters |
| **Electric Blue** | `#4DA6FF` | `rgb(77, 166, 255)` | Info alerts, documentation links, external integrations |

---

## 6. Typography System

| Typeface | Google Fonts Link | Weights | Usage |
|:---|:---|:---:|:---|
| **Space Grotesk** | https://fonts.google.com/specimen/Space+Grotesk | `600`, `700`, `800` | Logo, display titles, headlines, primary buttons, metric numerals |
| **Inter** | https://fonts.google.com/specimen/Inter | `400`, `500`, `600` | UI text, body copy, tables, forms, small labels |

---

## 7. Ready-to-Use CSS Tokens

```css
:root {
  /* Brand Accents */
  --neon: #3DFF7A;
  --neon-d: #2CC760;
  --glow: rgba(61, 255, 122, 0.12);
  --glow-s: rgba(61, 255, 122, 0.22);

  /* Backgrounds & Surfaces */
  --bg: #080D08;
  --bg-mid: #0B120B;
  --card: #0F170F;
  --card-h: #141E14;

  /* Borders */
  --border: #1A2C1A;
  --border-s: #223322;

  /* Text */
  --white: #F0F5F0;
  --text: #C4D4C4;
  --muted-l: #849484;
  --muted: #566056;

  /* Feedback */
  --red: #FF4D4D;
  --gold: #FFD700;
  --blue: #4DA6FF;

  /* Fonts */
  --font-display: 'Space Grotesk', sans-serif;
  --font-body: 'Inter', sans-serif;
}
```

---

## 8. Figma / Illustrator Quick Reference

- **Canvas Background:** `#080D08`
- **Component Container:** `#0F170F` with 1px stroke `#1A2C1A` and `12px` border radius
- **Hero CTA Button:** Fill `#3DFF7A` with Text `#060E06` (font: `Space Grotesk 700/800`, tracking tight), drop shadow `0 4px 20px rgba(61,255,122,0.22)`
- **Header Text:** `#F0F5F0` (Space Grotesk)
- **Body Text:** `#C4D4C4` (Inter Regular/Medium)
