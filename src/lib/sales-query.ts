import { queryOptions } from '@tanstack/react-query';
import { getSalesOverview } from './sales.functions';
export const salesQuery = queryOptions({ queryKey: ['sales'], queryFn: () => getSalesOverview(), staleTime: 0 });
