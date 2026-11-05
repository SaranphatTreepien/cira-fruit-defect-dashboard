import { useCallback, useRef } from 'react';

export function useMismatchWindow(size = 10) {
  const values = useRef<number[]>([]);
  const push = useCallback((mismatch: boolean) => {
    values.current = [...values.current, mismatch ? 1 : 0].slice(-size);
    return values.current.reduce((sum, item) => sum + item, 0);
  }, [size]);
  const reset = useCallback(() => { values.current = []; }, []);
  return { push, reset };
}
