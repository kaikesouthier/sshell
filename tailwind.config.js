// Mirrors the configuration that used to live inline in index.html beside the
// CDN <script>. Run `npm run css` after changing it.
const C = k => `rgb(var(--${k}-rgb) / <alpha-value>)`;

module.exports = {
    darkMode: 'class',
    content: [
        './index.html',
        './views/**/*.html',
        './app.js',
        './src/**/*.js'
    ],
    // dialog.js builds `text-${color}` at runtime, which the scanner cannot see.
    safelist: ['text-accent', 'text-ok', 'text-warn', 'text-bad'],
    theme: {
        extend: {
            colors: {
                bg: C('bg'), panel: C('panel'), panel2: C('panel2'), panel3: C('panel3'),
                edge: C('edge'), edge2: C('edge2'),
                txt: C('txt'), muted: C('muted'), faint: C('faint'),
                accent: { DEFAULT: C('accent'), hover: C('accentHover'), dim: C('accentDim') },
                ok: C('ok'), warn: C('warn'), bad: C('bad')
            },
            fontFamily: { mono: ['"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'] },
            boxShadow: { glow: '0 0 0 1px rgb(var(--accent-rgb)/0.4), 0 0 18px rgb(var(--accent-rgb)/0.25)' }
        }
    }
};
