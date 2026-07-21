import { useCallback, useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) || systemTheme());

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // shadcn's Tailwind `dark:` variant matches `.dark` on an ancestor, not
    // our data-theme attribute — keep both in sync so shadcn components
    // (badge, button, ai-elements) follow the same toggle as the rest of
    // the app instead of needing a second theme system.
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
