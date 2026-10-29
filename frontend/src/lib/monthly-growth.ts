/** Private monthly wire contract. Decimal measurements stay strings. */
export const GROWTH_NOTICE = 'Estimates use only the AWS data provided. Changes in cloud usage do not establish company or revenue growth. Missing exports, workload changes, discounts and billing adjustments can affect the result.'
export interface GrowthReason { code: string; message: string; recovery: string }
export interface GrowthSource { ordinal: number; upload_id: string; filename: string; sha256: string; role: 'primary' | 'baseline'; raw_rows: number; canonical_rows: number; removed_copy_rows: number }
export interface GrowthDriver { key: string[]; baseline_daily_quantity: string; current_daily_quantity: string; usage_change_percent: string; weight_percent: string }
export interface GrowthComparison {
  status: 'available' | 'unavailable'; comparison_id: string | null; observation_id: string | null;
  baseline_observation_id: string | null; baseline_check_id: string | null; baseline_month: string | null;
  spending_delta_cents: number | null; spending_change_percent: string | null; usage_change_percent: string | null;
  represented_groups: number; excluded_groups: number; other_driver_count: number; drivers: GrowthDriver[]; reasons: GrowthReason[]
}
export interface GrowthPeriod {
  observation_id: string; check_id: string; month: string; start: string; end: string;
  kind: 'previous' | 'current' | 'historical'; status: 'available' | 'partial' | 'unavailable'; complete: boolean;
  currency: 'USD' | null; basis: 'unblended'; charge_cents: number | null; captured_at: string; latest_source_at: string | null;
  observed_days: string[]; missing_days: string[]; sources: GrowthSource[];
  raw_rows: number; canonical_rows: number; removed_copy_rows: number; delivery_completeness: 'unverified';
  usage_observations: { key: string[]; quantity: string | null; unit: string; valid: boolean; source_upload_ids: string[] }[];
  usage_group_count: number; comparison: GrowthComparison; reasons: GrowthReason[]
}
export interface GrowthDashboard {
  version: 'monthly_growth_v1'; check_id: string; view_as_of: string; calculated_at: string;
  status: 'available' | 'unavailable' | 'preparing'; periods: GrowthPeriod[];
  reasons: GrowthReason[]; notice: string; can_prepare: boolean
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length <= max
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const money = (v: unknown) => v === null || (typeof v === 'number' && Number.isSafeInteger(v))
const decimal = (v: unknown) => v === null || (text(v, 180) && /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v) && Number.isFinite(Number(v)))
const date = (v: unknown): v is string => text(v, 10) && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
const instant = (v: unknown) => text(v, 40) && Number.isFinite(Date.parse(v))
const strings = (v: unknown, max: number) => list(v, max) && v.every(x => text(x))
const reasons = (v: unknown) => list(v, 40) && v.every(x => object(x) && text(x.code, 80) && text(x.message) && text(x.recovery))
function comparison(v: unknown): boolean {
  return object(v) && ['available', 'unavailable'].includes(String(v.status)) && money(v.spending_delta_cents)
    && (v.comparison_id === null || text(v.comparison_id, 64))
    && (v.observation_id === null || text(v.observation_id))
    && (v.baseline_observation_id === null || text(v.baseline_observation_id))
    && (v.baseline_check_id === null || text(v.baseline_check_id))
    && (v.baseline_month === null || date(v.baseline_month))
    && decimal(v.spending_change_percent) && decimal(v.usage_change_percent) && reasons(v.reasons)
    && count(v.represented_groups) && count(v.other_driver_count) && count(v.excluded_groups)
    && list(v.drivers, 20) && v.drivers.every(d => object(d) && strings(d.key, 9) && decimal(d.baseline_daily_quantity)
      && decimal(d.current_daily_quantity) && decimal(d.usage_change_percent) && decimal(d.weight_percent))
}
function period(v: unknown): boolean {
  return object(v) && text(v.observation_id) && text(v.check_id) && date(v.month) && date(v.start) && date(v.end)
    && ['previous', 'current', 'historical'].includes(String(v.kind)) && ['available', 'partial', 'unavailable'].includes(String(v.status))
    && typeof v.complete === 'boolean' && money(v.charge_cents) && (v.currency === null || v.currency === 'USD') && v.basis === 'unblended'
    && instant(v.captured_at) && (v.latest_source_at === null || instant(v.latest_source_at))
    && list(v.observed_days, 31) && v.observed_days.every(date) && list(v.missing_days, 31) && v.missing_days.every(date)
    && count(v.raw_rows) && count(v.canonical_rows) && count(v.removed_copy_rows) && count(v.usage_group_count)
    && v.delivery_completeness === 'unverified' && comparison(v.comparison) && reasons(v.reasons)
    && list(v.sources, 256) && v.sources.every(s => object(s) && text(s.filename, 512) && text(s.upload_id)
      && text(s.sha256, 64) && /^[0-9a-f]{64}$/.test(s.sha256) && ['primary', 'baseline'].includes(String(s.role))
      && count(s.ordinal) && count(s.raw_rows) && count(s.canonical_rows) && count(s.removed_copy_rows))
    && list(v.usage_observations, 20) && v.usage_observations.every(g => object(g) && strings(g.key, 9)
      && decimal(g.quantity) && text(g.unit) && typeof g.valid === 'boolean' && strings(g.source_upload_ids, 256))
}
export function isGrowthDashboard(v: unknown): v is GrowthDashboard {
  return object(v) && v.version === 'monthly_growth_v1' && text(v.check_id) && instant(v.view_as_of)
    && instant(v.calculated_at) && ['available', 'unavailable', 'preparing'].includes(String(v.status))
    && list(v.periods, 3) && v.periods.every(p => period(p) && object(p) && p.check_id === v.check_id)
    && reasons(v.reasons) && text(v.notice, 1000) && typeof v.can_prepare === 'boolean'
}
export function decodeGrowth(v: unknown): GrowthDashboard {
  if (!isGrowthDashboard(v)) throw new Error('Monthly evidence could not be verified. Run a new check or retry.')
  return v
}
