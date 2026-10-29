import defaultTheme from 'tailwindcss/defaultTheme'

/**
 * Tailwind config.
 *
 * Colour values live in `src/index.css` as CSS custom properties and are
 * referenced here by name. Nothing in this file holds a colour literal: that is
 * deliberate, because a hex in a config file and the same hex in a stylesheet
 * are two values that can drift, and they did - the app rendered light while
 * the landing rendered dark navy, with no failure to say so.
 *
 * The one rule this file does enforce is checked by `src/styles/tokens.test.ts`:
 * every `var(--name)` below must be a variable `index.css` actually defines.
 * Referencing a variable that does not exist is not a build error in Tailwind -
 * the class is emitted, and the colour silently fails to apply at runtime.
 *
 * ## Why every scale starts with `...defaultTheme.x`
 *
 * A first pass at this file *replaced* `fontSize` and `boxShadow` outright. That
 * is the wrong move in a restyle and it fails quietly: the app uses `text-sm`
 * 103 times, `text-xs` 27, `text-3xl` 26, `text-2xl` 24, and `shadow` 4 times,
 * and Tailwind does not error on a class it has no value for - it just stops
 * emitting the rule, so 158 declarations would have lost their size or shadow
 * with a green build.
 *
 * So the defaults stay, and the design system's steps are *added* alongside
 * them. Where a name collides with a default (`rounded-md` is both a Tailwind
 * step and a landing radius) the landing value wins, because that is the whole
 * point of the restyle; where it does not collide, both work. The new
 * primitives use the token names, and the pages migrate onto them in Step 3.
 */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // The brand. `bg-accent`, `text-accent`, `border-accent`.
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          foreground: 'var(--accent-foreground)',
          tint: 'var(--accent-tint)',
          border: 'var(--accent-border)',
        },
        // The page. `bg-base`, `bg-base-raised`.
        base: {
          DEFAULT: 'var(--base)',
          raised: 'var(--base-raised)',
        },
        // Raised surfaces. `bg-surface`, `bg-surface-raised`, `bg-surface-hover`.
        surface: {
          DEFAULT: 'var(--surface)',
          raised: 'var(--surface-raised)',
          alt: 'var(--surface-alt)',
          hover: 'var(--surface-hover)',
        },
        // Text.
        foreground: 'var(--foreground)',
        subtle: 'var(--subtle-foreground)',

        // `card` and `popover` are the pre-existing shadcn names for two of the
        // surfaces above. The pages say `card`; the token system says `surface`.
        // Both class names exist so the rename can happen one primitive at a
        // time instead of in one commit that touches every file.
        card: {
          DEFAULT: 'var(--surface)',
          foreground: 'var(--foreground)',
        },
        popover: {
          DEFAULT: 'var(--surface-raised)',
          foreground: 'var(--foreground)',
        },

        // A flat surface for a whole control: a segmented background, a table
        // stripe, a progress track.
        muted: {
          DEFAULT: 'var(--surface-alt)',
          foreground: 'var(--muted-foreground)',
        },

        // Status.
        danger: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
          tint: 'var(--danger-tint)',
        },
        success: {
          DEFAULT: 'var(--success)',
          tint: 'var(--success-tint)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          tint: 'var(--warning-tint)',
        },
        info: {
          DEFAULT: 'var(--info)',
          tint: 'var(--info-tint)',
        },
        violet: 'var(--violet)',

        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',

        /*
         * `card` and `popover` above are a separate, still-open rename: the
         * pre-existing shadcn surface names. `background` and `primary`, the
         * other two shadcn leftovers, were deleted once the last page was
         * rebuilt in Step 3 - the migration they existed to stage. The guard in
         * `tokens.test.ts` now fails if either name is re-added while a call
         * site still refers to it, which is the order a well-meaning cleanup
         * would try and the order that produces a page with no colour and no
         * warning.
         */
      },

      /*
       * Radii override the defaults rather than adding to them: `rounded-md`,
       * `rounded-lg` and `rounded` are already in use 17, 7 and 3 times, and
       * every one of those is a corner the landing draws differently. The
       * numbers come from `src/styles/tokens.ts` - 6px, 9px, 14px, of which only
       * the first and last are the same as a Tailwind default.
       */
      borderRadius: {
        ...defaultTheme.borderRadius,
        sm: '0.375rem',
        DEFAULT: '0.375rem',
        md: '0.5625rem',
        // 13px, the radius on every card in the landing. 14px belongs to the
        // two largest panels, which is `xl` here.
        lg: '0.8125rem',
        xl: '0.875rem',
        full: '9999px',
      },

      fontFamily: {
        ...defaultTheme.fontFamily,
        sans: ['DM Sans', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['DM Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      /*
       * The type scale. `display-1` and `display-2` are the landing's own
       * clamp()ed values and are for marketing surfaces; the four between them
       * interpolate a 1.2 ratio anchored on the landing's card sizes, and are
       * therefore not round numbers. None of these names collides with a
       * Tailwind default, so `text-sm` and `text-h2` sit side by side until
       * Step 3 finishes moving the pages across.
       */
      fontSize: {
        ...defaultTheme.fontSize,
        'display-1': ['clamp(2.55rem, 6vw, 5.2rem)', { lineHeight: '1.08', letterSpacing: '-0.045em' }],
        'display-2': ['clamp(2rem, 4vw, 3.5rem)', { lineHeight: '1.08', letterSpacing: '-0.045em' }],
        h1: ['2.125rem', { lineHeight: '1.08', letterSpacing: '-0.045em' }],
        h2: ['1.375rem', { lineHeight: '1.08', letterSpacing: '-0.045em' }],
        h3: ['1.125rem', { lineHeight: '1.2', letterSpacing: '-0.045em' }],
        body: ['1rem', { lineHeight: '1.65' }],
        caption: ['0.75rem', { lineHeight: '1.4' }],
        mono: ['0.75rem', { lineHeight: '1.4' }],
      },

      /*
       * Elevation. The landing's shadows are accent-tinted rather than neutral,
       * and that is the right call on a navy background: a black shadow on a
       * near-black surface is invisible, so the cyan glow is what actually
       * lifts a surface off the page. `card` is the one neutral shadow, and it
       * is the one derived value - the landing separates cards with a border
       * and no shadow at all.
       */
      boxShadow: {
        ...defaultTheme.boxShadow,
        glow: '0 10px 25px var(--accent-glow)',
        'glow-lg': '0 14px 30px var(--accent-glow-strong)',
        halo: '0 0 0 5px var(--accent-tint)',
        panel: '0 30px 90px var(--scrim-strong)',
        card: '0 1px 2px 0 var(--shadow-card)',
      },

      /*
       * Tracking. `label` is the landing's `.eyebrow` at `0.13em`, and it is
       * what makes a `font-mono text-mono uppercase` label read as a label
       * rather than as a small piece of body text. `tight` is the heading
       * tracking, already applied by the fontSize steps above; exposed here as
       * well so a component can tighten an arbitrary element.
       */
      letterSpacing: {
        ...defaultTheme.letterSpacing,
        tight: '-0.045em',
        label: '0.13em',
      },

      /*
       * Motion. `fast` and `base`/`slow` are the landing's own timings - 150ms
       * is `derived` and exists because 250ms reads as sluggish on a hover on a
       * 32px control. `landing` is kept as a synonym for `base` because the
       * Step 1 primitives were written against it before these were named.
       */
      transitionDuration: {
        ...defaultTheme.transitionDuration,
        fast: '150ms',
        base: '250ms',
        slow: '300ms',
        landing: '250ms',
      },

      transitionTimingFunction: {
        ...defaultTheme.transitionTimingFunction,
        // The landing uses a plain `ease` on every transition it has.
        landing: 'ease',
      },
    },
  },
  plugins: [],
}
