/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#0B0D12',
          card: 'rgba(255,255,255,0.04)',
          hover: 'rgba(255,255,255,0.07)',
        },
        accent: {
          indigo: '#6366F1',
          cyan: '#22D3EE',
        },
        success: '#34D399',
        warning: '#FBBF24',
        danger: '#F87171',
        muted: 'rgba(255,255,255,0.45)',
        border: 'rgba(255,255,255,0.08)',
      },
      fontFamily: {
        sans: ['"Geist Variable"', 'Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        card: '20px',
      },
      backgroundImage: {
        'gradient-accent': 'linear-gradient(135deg, #6366F1, #22D3EE)',
        'gradient-glow': 'radial-gradient(ellipse 60% 50% at 0% 0%, rgba(99,102,241,0.15) 0%, transparent 100%)',
      },
      animation: {
        'count-up': 'countUp 0.6s ease-out',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-in': 'slideIn 0.3s ease-out',
      },
      keyframes: {
        countUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideIn: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
