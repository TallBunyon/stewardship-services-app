import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        teal: {
          accent: '#2cc5a0',
          dark: '#1fa882',
          light: '#4dd4b5',
        },
        bg: {
          base: '#0d0d0d',
          card: '#161616',
          surface: '#1e1e1e',
          border: '#2a2a2a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        bounce3: {
          '0%, 80%, 100%': { transform: 'translateY(0)' },
          '40%': { transform: 'translateY(-6px)' },
        },
      },
      animation: {
        blink: 'blink 1s step-start infinite',
        fadeIn: 'fadeIn 0.25s ease-out forwards',
        bounce3: 'bounce3 1.2s infinite ease-in-out',
      },
    },
  },
  plugins: [],
}

export default config
