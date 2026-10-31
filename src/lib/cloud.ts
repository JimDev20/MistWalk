/* MistWalk Supabase bridge — optional cloud backup, local-first by default. */

import {
	createClient,
	type SupabaseClient,
	type Subscription,
	type User
} from '@supabase/supabase-js';
import type { BackupFile } from './types.ts';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const cloudConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let client: SupabaseClient | null = null;
let authSubscription: Subscription | null = null;

function getClient(): SupabaseClient | null {
	if (!cloudConfigured) return null;
	if (!client) {
		client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
			auth: {
				persistSession: true,
				autoRefreshToken: true,
				detectSessionInUrl: true
			}
		});
	}
	return client;
}

export async function getCloudUser(): Promise<User | null> {
	const supabase = getClient();
	if (!supabase) return null;
	const { data, error } = await supabase.auth.getUser();
	if (error) return null;
	return data.user || null;
}

export async function watchCloudAuth(callback: (user: User | null) => void): Promise<() => void> {
	const supabase = getClient();
	if (!supabase) {
		callback(null);
		return () => {};
	}
	const {
		data: { session }
	} = await supabase.auth.getSession();
	callback(session?.user || null);
	if (authSubscription) authSubscription.unsubscribe();
	const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
		callback(nextSession?.user || null);
	});
	authSubscription = data.subscription;
	return () => {
		authSubscription?.unsubscribe();
		authSubscription = null;
	};
}

export async function sendMagicLink(email: string): Promise<boolean> {
	const supabase = getClient();
	if (!supabase) throw new Error('Cloud sync is not configured.');
	const { error } = await supabase.auth.signInWithOtp({
		email,
		options: { emailRedirectTo: window.location.origin }
	});
	if (error) throw error;
	return true;
}

export async function cloudSignOut(): Promise<void> {
	const supabase = getClient();
	if (!supabase) return;
	const { error } = await supabase.auth.signOut();
	if (error) throw error;
}

export async function fetchCloudMeta(): Promise<{
	saved_at: number;
	updated_at: string;
} | null> {
	const supabase = getClient();
	if (!supabase) return null;
	const user = await getCloudUser();
	if (!user) return null;
	const { data, error } = await supabase
		.from('mistwalk_backups')
		.select('saved_at, updated_at')
		.eq('user_id', user.id)
		.maybeSingle();
	if (error) throw error;
	return data || null;
}

export async function fetchCloudBackup(): Promise<{
	data: BackupFile;
	saved_at: number;
	updated_at: string;
} | null> {
	const supabase = getClient();
	if (!supabase) throw new Error('Cloud sync is not configured.');
	const user = await getCloudUser();
	if (!user) throw new Error('Sign in to restore a cloud backup.');
	const { data, error } = await supabase
		.from('mistwalk_backups')
		.select('data, saved_at, updated_at')
		.eq('user_id', user.id)
		.maybeSingle();
	if (error) throw error;
	return data || null;
}

export async function deleteCloudBackup(): Promise<boolean> {
	const supabase = getClient();
	if (!supabase) throw new Error('Cloud sync is not configured.');
	const user = await getCloudUser();
	if (!user) throw new Error('Sign in to delete a cloud backup.');
	const { error } = await supabase.from('mistwalk_backups').delete().eq('user_id', user.id);
	if (error) throw error;
	return true;
}

export async function uploadCloudBackup(backup: BackupFile) {
	const supabase = getClient();
	if (!supabase) throw new Error('Cloud sync is not configured.');
	const user = await getCloudUser();
	if (!user) throw new Error('Sign in to upload a cloud backup.');
	const row = {
		user_id: user.id,
		data: backup,
		saved_at: Date.now(),
		updated_at: new Date().toISOString()
	};
	const { error } = await supabase.from('mistwalk_backups').upsert(row, { onConflict: 'user_id' });
	if (error) throw error;
	return row;
}
