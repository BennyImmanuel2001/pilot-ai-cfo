import { useState, useCallback, useEffect } from 'react';
import { DashboardSpec } from '../spec';
import { fetchDefaultDashboard } from '../lib/api';

export function useDashboard() {
  const [spec, setSpec] = useState<DashboardSpec | null>(null);
  const [specKey, setSpecKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const loadDefault = useCallback(async () => {
    setIsLoading(true);
    const result = await fetchDefaultDashboard();
    if (result) {
      setSpec(result);
      setSpecKey(k => k + 1);
      setFailed(false);
    } else {
      setFailed(true);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadDefault();
  }, [loadDefault]);

  const updateSpec = useCallback((next: DashboardSpec) => {
    setSpec(next);
    setSpecKey(k => k + 1);
    setIsLoading(false);
    setFailed(false);
  }, []);

  return { spec, specKey, isLoading, setIsLoading, failed, updateSpec, reload: loadDefault };
}
