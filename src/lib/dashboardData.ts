import type { AlertItem, FruitEvent } from '@/data/mockData';

export type DashboardSummary = {
  total: number;
  good: number;
  external: number;
  internal: number;
  wrong: number;
  averageConfidence: number | null;
  nirCoverage: number | null;
  lastEventAt: string | null;
};

export type DashboardData = {
  source: 'postgres' | 'unavailable';
  events: FruitEvent[];
  alerts: AlertItem[];
  summary: DashboardSummary;
  database: {
    connected: boolean;
    eventCount: number;
    lastEventAt: string | null;
  };
  error?: string;
};

export const emptyDashboardSummary: DashboardSummary = {
  total: 0,
  good: 0,
  external: 0,
  internal: 0,
  wrong: 0,
  averageConfidence: null,
  nirCoverage: null,
  lastEventAt: null,
};
