import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ink: '#10352A',
        leaf: '#1AA55C',
        'leaf-dark': '#087444',
        mint: '#F5FAF3',
        'mint-card': '#DFF3E4',
        orange: '#FF8A24',
        'orange-soft': '#FFEFE0',
        surface: '#FFFFFF',
        line: '#E4EEE7',
      },
      fontFamily: {
        sans: ['var(--font-thai)', 'Noto Sans Thai', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 10px 30px rgba(16, 53, 42, 0.07)',
        float: '0 18px 50px rgba(16, 53, 42, 0.12)',
      },
      borderRadius: {
        '2xl': '1.25rem',
      },
    },
  },
  plugins: [],
};

export default config;
