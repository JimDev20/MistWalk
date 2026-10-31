export type ProfileName = 'live' | 'demo';
export type Units = 'metric' | 'imperial';
export type MapProvider = 'osm' | 'google';
export type Basemap = 'osm' | 'osmfr' | 'cyclosm';

export interface LatLng {
	lat: number;
	lng: number;
}

export type PathPoint = [number, number, number];

export interface GridCell {
	x: number;
	y: number;
	key: string;
}

export interface CellBounds {
	west: number;
	north: number;
	east: number;
	south: number;
}

export interface CellMeta {
	t: number;
	n: number;
	s?: string;
	lt?: number;
}

export interface NoteData {
	text: string;
	t: number;
}

export interface NoteItem extends NoteData {
	key: string;
	lat: number;
	lng: number;
	coordsLabel?: string;
	dateLabel?: string;
}

export interface LastView {
	lat?: number;
	lng?: number;
	zoom?: number;
	at?: number;
}

export interface NormalizedFix {
	lat: number;
	lng: number;
	accuracy: number | null;
	t: number;
	speed: number | null;
	heading: number | null;
}

export interface FixInput {
	lat?: unknown;
	lng?: unknown;
	accuracy?: unknown;
	t?: unknown;
	speed?: unknown;
	heading?: unknown;
}

export interface Verdict {
	unlock: boolean;
	walking: boolean;
	reason: string;
	distance: number;
	speed: number | null;
	vehicle: boolean;
	accuracyOk: boolean;
	from?: NormalizedFix;
	to?: NormalizedFix;
}

export interface ProgressStatsData {
	distance: number;
	walkingMs: number;
	sessions: number;
	unlocks: number;
	startedAt: number;
	lastWalkAt: number;
}

export interface ProgressSettings {
	units: Units;
	sound: boolean;
	haptics: boolean;
	autoTrack: boolean;
	wakeLock: boolean;
}

export interface ArchivedSession {
	id: string;
	startedAt: number;
	endedAt: number;
	distance: number;
	walkingMs: number;
	unlocks: number;
	profile: ProfileName;
	path: PathPoint[];
}

export interface ActiveSession {
	id: string;
	startedAt: number;
	pausedAt: number | null;
	lastAcceptedAt: number | null;
	distance: number;
	walkingMs: number;
	unlocks: number;
	speed: number;
	profile: ProfileName;
	path: PathPoint[];
	archived: boolean;
}

export interface Progress {
	version: number;
	cells: Record<string, CellMeta>;
	path: PathPoint[];
	sessions: ArchivedSession[];
	notes: Record<string, NoteData>;
	stats: ProgressStatsData;
	last: LastView | null;
	settings: ProgressSettings;
}

export interface LevelDefinition {
	min: number;
	name: string;
	tag: string;
}

export interface Level extends LevelDefinition {
	index: number;
	next: LevelDefinition | null;
	progress: number;
}

export interface ProgressSummary {
	cellCount: number;
	areaM2: number;
	visits: number;
	favoriteCells: number;
	maxVisits: number;
	archivedSessions: number;
	sessions: number;
	notes: number;
	days: number;
	streak: number;
	firstAt: number | null;
	lastAt: number | null;
	level: Level;
	distance: number;
	walkingMs: number;
}

export interface SessionView extends ArchivedSession {
	dateLabel: string;
	durationLabel: string;
	distanceLabel: string;
	profileLabel: string;
	pointCount: number;
}

export interface Achievement {
	id: string;
	title: string;
	detail: string;
	metric: string;
	target: number;
	value: number;
	earned: boolean;
	progress: number;
}

export interface GpsQuality {
	level: string;
	label: string;
	detail: string;
}

export interface GuideTarget {
	key: string;
	lat: number;
	lng: number;
	distance: number;
	bearing: number | null;
	rings: number;
}

export interface Challenge {
	title: string;
	target: number;
	metric: string;
}

export interface ChallengeInfo extends Challenge {
	current: number;
	remaining: number;
	percent: number;
	complete: boolean;
}

export interface ReplayTrackInput {
	id?: string;
	path: PathPoint[];
	label?: string;
	detail?: string;
}

export interface ReplayState {
	id: string;
	path: PathPoint[];
	label: string;
	detail: string;
	index: number;
	playing: boolean;
	rate: number;
	lastFrame: number;
}

export interface MapEngine {
	canvas: HTMLCanvasElement;
	basemap: Basemap;
	readonly width?: number;
	readonly height?: number;
	readonly center: LatLng;
	readonly zoom: number;
	readonly bounds: CellBounds | null;
	readonly providerLabel: string;
	project(lat: number, lng: number): { x: number; y: number } | null;
	unproject?(x: number, y: number): LatLng | null;
	setView(lat: number, lng: number, zoom?: number, animate?: boolean): void;
	panTo(lat: number, lng: number, animate?: boolean): void;
	fitBounds(bounds: CellBounds, padding?: number): void;
	zoomBy(delta: number): void;
	setBasemap?(name: Basemap): void;
	resize?(): void;
	destroy(): void;
}

export interface SearchResult {
	lat: number | string;
	lon: number | string;
	display_name?: string;
	name?: string;
	place_id?: number | string;
}

export interface BatteryState {
	level: number;
	charging: boolean;
}

export interface AttributionPart {
	text: string;
	href?: string;
}

export interface Settings {
	provider: MapProvider;
	basemap: Basemap;
	googleKey: string;
	units: Units;
	sound: boolean;
	haptics: boolean;
	wakeLock: boolean;
	showGrid: boolean;
	showFavorites: boolean;
	theme: 'night' | 'paper';
	highContrast: boolean;
	reduceMotion: boolean;
	autoTrack: boolean;
	onboarded: boolean;
	lastProfile: ProfileName;
}

export type MemberStatus = 'pending' | 'approved' | 'rejected';
export type MemberRole = 'admin' | 'member';
export type AccessStatus =
	'local' | 'checking' | 'signed-out' | 'pending' | 'approved' | 'rejected' | 'error';

export interface MemberRecord {
	user_id: string;
	email: string | null;
	status: MemberStatus;
	role: MemberRole;
	created_at: string;
	decided_at: string | null;
	decided_by: string | null;
}

export interface InviteRecord {
	code: string;
	created_by: string;
	created_at: string;
	expires_at: string;
	used_by: string | null;
	used_at: string | null;
}

export interface BackupFile {
	app: 'MistWalk';
	format: number;
	exportedAt: string;
	settings: Settings;
	profiles: {
		live: Progress;
		demo: Progress;
	};
}

export interface ImportedBackup {
	live: Progress;
	demo: Progress;
	settings: Settings | null;
}
