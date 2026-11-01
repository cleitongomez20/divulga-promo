import { queryOptions } from '@tanstack/react-query';
import { getSalesOverview } from './sales.functions';
import type { PeriodKey } from './conversions';

export const salesQuery = (period: PeriodKey = 'month') => queryOptions({ queryKey: ['sales', period], queryFn: () => getSalesOverview({ data: { period } }), staleTime: 0 });
