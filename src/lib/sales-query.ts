import { queryOptions } from '@tanstack/react-query';
import { getSalesOverview } from './sales.functions';
import type { PeriodKey } from './conversions';

export const salesQuery = (period: PeriodKey = 'month', custom?: { from: string; to: string }) =>
  queryOptions({ queryKey: ['sales', period, custom?.from ?? null, custom?.to ?? null], queryFn: () => getSalesOverview({ data: { period, ...(period === 'custom' && custom ? custom : {}) } }), staleTime: 0 });
