import Engine from '../indexing/engine';
import { DEFAULTS, type AcademicSettingsData } from '../settings';
import { customPalettes, paletteOverrides, selectedPalette, migratePaletteSettings, PRESETS } from '../rendering/palettes';
import { t } from '../i18n';

const JSON_FIELDS = ['customEnvironments', 'referenceOverrides', 'customPalettes', 'paletteAppearance'] as const;
const VALUE_FIELDS = ['lightPalette', 'darkPalette', 'neutralBody', 'hideMotif', 'shortReferences', 'theoremFormat', 'eqFormat', 'figureFormat', 'tableFormat', 'algorithmFormat'] as const;
type SharedKey = typeof JSON_FIELDS[number] | typeof VALUE_FIELDS[number];
export interface StyleProfile { kind: 'academic-notes-style'; version: 1; settings: Record<SharedKey, unknown> }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function stable(value: unknown): string {
    if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
function shared(settings: AcademicSettingsData): StyleProfile['settings'] {
    return { ...Object.fromEntries(VALUE_FIELDS.map(key => [key, settings[key]])),
        customEnvironments: Engine.environments(settings), referenceOverrides: Engine.referenceOverrides(settings),
        customPalettes: customPalettes(settings.customPalettes), paletteAppearance: paletteOverrides(settings)
    } as StyleProfile['settings'];
}
export function exportProfile(settings: AcademicSettingsData): string {
    const copy = { ...settings }; Engine.migrateReferenceFormats(copy); migratePaletteSettings(copy);
    return JSON.stringify({ kind: 'academic-notes-style', version: 1, settings: shared(copy) }, null, 2);
}
export function parseProfile(raw: string): StyleProfile {
    if (raw.length > 700000) throw new Error(t('方案文件过大，最多允许 700 KB 文本。'));
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new Error(t('方案不是有效的 JSON。')); }
    if (!object(data) || data.kind !== 'academic-notes-style' || data.version !== 1 || !object(data.settings) ||
        Object.keys(data).some(key => !['kind', 'version', 'settings'].includes(key))) throw new Error(t('方案格式或版本不受支持。'));
    const input = data.settings, allowed = [...JSON_FIELDS, ...VALUE_FIELDS];
    if (Object.keys(input).length !== allowed.length || Object.keys(input).some(key => !allowed.includes(key as SharedKey))) throw new Error(t('方案含有缺失或不允许的设置项。'));
    const candidate = { ...DEFAULTS };
    for (const key of VALUE_FIELDS) {
        const value = input[key];
        if (typeof value !== typeof DEFAULTS[key] || typeof value === 'string' && value.length > 500) throw new Error(t('方案设置值无效：{0}', key));
        Object.assign(candidate, { [key]: value });
    }
    for (const key of JSON_FIELDS) {
        if (!object(input[key])) throw new Error(t('方案设置值无效：{0}', key));
        candidate[key] = JSON.stringify(input[key]);
    }
    // The normal runtime validators reject arbitrary CSS, unknown motifs, reserved
    // environment IDs, prototype keys and excessive counts. Require lossless validation.
    const canonical = shared(candidate);
    if (stable(input) !== stable(canonical) || selectedPalette(candidate, 'light') !== candidate.lightPalette || selectedPalette(candidate, 'dark') !== candidate.darkPalette)
        throw new Error(t('方案包含无效的环境、颜色、图标或配色引用。'));
    return { kind: 'academic-notes-style', version: 1, settings: canonical };
}
function mergeMap(local: Record<string, unknown>, incoming: Record<string, unknown>, replace: boolean) { return replace ? { ...local, ...incoming } : { ...incoming, ...local }; }
export function mergeProfile(settings: AcademicSettingsData, profile: StyleProfile, replace: boolean, activate: boolean): AcademicSettingsData {
    // Validate even when called programmatically; unrelated local preferences survive.
    const input = parseProfile(JSON.stringify(profile)).settings, result = { ...settings };
    const local = shared(settings);
    for (const key of JSON_FIELDS) {
        if (key === 'paletteAppearance') {
            const merged = { ...local[key] as Record<string, Record<string, unknown>> };
            for (const [palette, roles] of Object.entries(input[key] as Record<string, Record<string, unknown>>))
                merged[palette] = mergeMap(merged[palette] || {}, roles, replace);
            result[key] = JSON.stringify(merged);
        } else result[key] = JSON.stringify(mergeMap(local[key] as Record<string, unknown>, input[key] as Record<string, unknown>, replace));
    }
    if (activate) for (const key of VALUE_FIELDS) Object.assign(result, { [key]: input[key] });
    // A merge can exceed limits even if both original profiles are valid.
    parseProfile(JSON.stringify({ kind: 'academic-notes-style', version: 1, settings: {
        ...Object.fromEntries(VALUE_FIELDS.map(key => [key, result[key]])),
        ...Object.fromEntries(JSON_FIELDS.map(key => [key, JSON.parse(result[key]) as unknown]))
    } }));
    return result;
}
export function profileSummary(profile: StyleProfile, settings: AcademicSettingsData) {
    const local = shared(settings), incoming = profile.settings;
    const environmentSettings = { customEnvironments: JSON.stringify(incoming.customEnvironments), referenceOverrides: JSON.stringify(incoming.referenceOverrides) };
    const palettes = customPalettes(JSON.stringify(incoming.customPalettes));
    const entries: { name: string; conflict: boolean }[] = [];
    for (const key of JSON_FIELDS) {
        for (const [name, value] of Object.entries(incoming[key] as Record<string, unknown>)) {
            if (key === 'paletteAppearance') {
                for (const role of Object.keys(value as object)) entries.push({ name: `${palettes[name]?.name || PRESETS[name]?.name || t('跟随主题主色')} / ${Engine.labelName(role, environmentSettings)}`, conflict: Object.hasOwn((local[key] as Record<string, object>)[name] || {}, role) });
            } else entries.push({ name: key === 'customPalettes' ? palettes[name]?.name || name : Engine.labelName(name, environmentSettings), conflict: Object.hasOwn(local[key] as object, name) });
        }
    }
    return entries;
}
