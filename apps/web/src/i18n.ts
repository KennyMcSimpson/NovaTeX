import { createContext, useContext } from 'react';

export type UiLocale = 'en' | 'zh';

export function detectInitialLocale(): UiLocale {
  if (typeof window === 'undefined') return 'en';
  try {
    const params = new URLSearchParams(window.location.search);
    const qp = params.get('lang')?.toLowerCase();
    if (qp === 'en' || qp === 'en-us') return 'en';
    if (qp === 'zh' || qp === 'zh-cn') return 'zh';
    const saved = window.localStorage.getItem('novatex-lang');
    if (saved === 'en' || saved === 'zh') return saved;
    const navLang = (window.navigator?.language || '').toLowerCase();
    return navLang.startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

export interface LocaleContextValue {
  locale: UiLocale;
  setLocale: (next: UiLocale) => void;
  /** Lightweight bilingual helper: picks English when locale === 'en', Chinese when locale === 'zh' */
  tr: (en: string, zh: string) => string;
}

export const LocaleContext = createContext<LocaleContextValue>({
  locale: 'en',
  setLocale: () => {},
  tr: (en) => en,
});

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
