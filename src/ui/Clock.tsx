import { createContext, useContext, useEffect, useState } from 'react';
const Clock = createContext(Date.now());
export function ClockProvider({ children }: { children: React.ReactNode }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <Clock.Provider value={now}>{children}</Clock.Provider>;
}
export function useClock(): number {
  return useContext(Clock);
}
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
