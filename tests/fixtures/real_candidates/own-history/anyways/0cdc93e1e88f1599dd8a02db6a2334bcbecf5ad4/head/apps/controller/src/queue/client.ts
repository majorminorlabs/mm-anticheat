import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../config.js';
import type { Job } from '../jobs/types.js';

type CandidateRecord = { id: string; status: string; classification: Record<string, unknown> | null };

export function canClaimNextJob(job: Job | null, providerReady: boolean) {
  const v1 = ['v1', 'pipeline-v1'].includes(String(job?.parameters?.pipeline_version || ''));
  const requiresCloudProvider = v1 || job?.job_type === 'luna_editorial_candidate';
  return !requiresCloudProvider || providerReady;
}

export class Queue {
  readonly db: SupabaseClient;

  constructor(private config: Config) {
    this.db = createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async rpc<T>(fn: string, args: Record<string, unknown> = {}) {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }

  async nextQueued() {
    const { data, error } = await this.db.from('pipeline_jobs').select('*').eq('status', 'queued').lte('not_before', new Date().toISOString()).is('cancellation_requested_at', null).order('priority_rank', { ascending: false }).order('queue_position', { ascending: true }).order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (error) throw new Error(`next_pipeline_job: ${error.message}`);
    return data as Job | null;
  }

  async claim(providerReady = true) {
    const next = await this.nextQueued();
    if (!canClaimNextJob(next, providerReady)) return null;
    const requestedLease = next?.job_type === 'luna_editorial_candidate' && Number.isInteger(next.parameters?.processing_lease_minutes)
      ? Math.min(10_800, Math.max(30, Number(next.parameters.processing_lease_minutes) * 60))
      : this.config.leaseSeconds;
    const job = await this.rpc<Job>('claim_next_pipeline_job', { p_lease_owner: this.config.controllerId, p_lease_seconds: requestedLease });
    return job?.id ? job : null;
  }

  start(id: string) { return this.rpc<boolean>('start_pipeline_job', { p_job_id: id, p_lease_owner: this.config.controllerId }); }
  heartbeat(id: string, leaseSeconds = this.config.leaseSeconds) { return this.rpc<boolean>('heartbeat_pipeline_job', { p_job_id: id, p_lease_owner: this.config.controllerId, p_lease_seconds: leaseSeconds }); }
  complete(id: string, result: unknown, log: string) { return this.rpc<boolean>('complete_pipeline_job', { p_job_id: id, p_lease_owner: this.config.controllerId, p_result: result, p_summary_log: log }); }
  fail(id: string, error: unknown, log: string) { return this.rpc<Job>('fail_pipeline_job', { p_job_id: id, p_lease_owner: this.config.controllerId, p_error: error, p_summary_log: log, p_retry_delay_seconds: this.config.retryDelaySeconds }); }
  deferResource(id: string, error: unknown, log: string, delaySeconds = 60) { return this.rpc<Job>('defer_pipeline_job', { p_job_id: id, p_lease_owner: this.config.controllerId, p_error: error, p_summary_log: log, p_delay_seconds: delaySeconds }); }
  cancel(id: string, log: string) { return this.rpc<boolean>('cancel_pipeline_job', { p_job_id: id, p_lease_owner: this.config.controllerId, p_summary_log: log }); }
  releaseExpired() { return this.rpc<number>('release_expired_pipeline_job_leases'); }
  queueEditorialAutomation() { return this.rpc<Record<string, unknown>>('queue_editorial_automation'); }
  queueXBrowserIngestion() { return this.rpc<Record<string, unknown>>('queue_x_browser_ingestion_v2'); }
  recordControllerHealth(state: Record<string, unknown>) { return this.rpc<Record<string, unknown>>('record_pipeline_controller_health', { p_controller_id: this.config.controllerId, p_state: state }); }
  lock(id: string, resourceName = 'heavy_model') { return this.rpc<boolean>('acquire_pipeline_resource_lock', { p_name: resourceName, p_lease_owner: this.config.controllerId, p_job_id: id, p_lease_seconds: this.config.leaseSeconds }); }
  unlock(id: string, resourceName = 'heavy_model') { return this.rpc<boolean>('release_pipeline_resource_lock', { p_name: resourceName, p_job_id: id, p_lease_owner: this.config.controllerId }); }
  event(id: string, level: string, type: string, message: string, metadata: Record<string, unknown> = {}) { return this.rpc<void>('append_pipeline_job_event', { p_job_id: id, p_level: level, p_event_type: type, p_message: message, p_metadata: metadata }); }

  async recoverInterruptedGeneratePitch(job: Job, reason: { code: string; message: string }) {
    if (job.job_type !== 'generate_pitch' || typeof job.parameters?.proposal_id !== 'string') return false;
    const result = await this.rpc<Record<string, unknown>>('finish_generate_pitch', {
      p_job_id: job.id,
      p_proposal_id: job.parameters.proposal_id,
      p_status: 'failed',
      p_pitch: null,
      p_error: { ...reason, retryable: true },
      p_model: typeof job.parameters.model === 'string' ? job.parameters.model : this.config.ollamaModel,
      p_prompt_version: typeof job.parameters.prompt_version === 'string' ? job.parameters.prompt_version : 'editorial-pitch-gate-v3',
      p_retryable: true
    });
    await this.event(job.id, 'warn', 'generate_pitch_requeued', 'Qwen pitch was requeued after controller interruption.', { proposal_id: job.parameters.proposal_id, ...reason });
    return Boolean(result);
  }

  async expiredV1Jobs() {
    const { data, error } = await this.db.from('pipeline_jobs').select('*').in('status', ['claimed', 'running']).lt('lease_expires_at', new Date().toISOString());
    if (error) throw new Error(`expired_pipeline_jobs: ${error.message}`);
    return (data || []).filter(job => ['v1', 'pipeline-v1'].includes(String(job.parameters?.pipeline_version || ''))) as Job[];
  }

  async expiredGeneratePitchJobs() {
    const { data, error } = await this.db.from('pipeline_jobs').select('*').eq('job_type', 'generate_pitch').in('status', ['claimed', 'running']).lt('lease_expires_at', new Date().toISOString());
    if (error) throw new Error(`expired_generate_pitch_jobs: ${error.message}`);
    return (data || []) as Job[];
  }

  async terminalizeInterruptedCandidate(job: Job, reason: { code: string; message: string }) {
    if (!['v1', 'pipeline-v1'].includes(String(job.parameters?.pipeline_version || '')) || !job.pipeline_candidate_id) return false;
    const { data, error: readError } = await this.db.from('candidate_stories').select('id,status,classification').eq('id', job.pipeline_candidate_id).maybeSingle();
    if (readError) throw new Error(`candidate_terminalization_read: ${readError.message}`);
    const candidate = data as CandidateRecord | null;
    if (!candidate || candidate.status !== 'researching') return false;
    const classification = candidate.classification && typeof candidate.classification === 'object' ? candidate.classification : {};
    const nextClassification = {
      ...classification,
      phase2_state: 'failed',
      phase2_terminal_state: 'aborted',
      phase2_failure: { code: reason.code, message: reason.message, job_id: job.id, at: new Date().toISOString() }
    };
    const { error: updateError } = await this.db.from('candidate_stories').update({ status: 'verification_failed', classification: nextClassification, updated_at: new Date().toISOString() }).eq('id', candidate.id).eq('status', 'researching');
    if (updateError) throw new Error(`candidate_terminalization_update: ${updateError.message}`);
    await this.event(job.id, 'error', 'candidate_terminalized', 'Pipeline V1 candidate terminalized after controller interruption.', { candidate_id: candidate.id, status: 'verification_failed', ...reason });
    return true;
  }

  async reconcileExpiredJobs() {
    const expiredGeneratePitch = await this.expiredGeneratePitchJobs();
    const expiredV1 = await this.expiredV1Jobs();
    const released = await this.releaseExpired();
    for (const job of expiredGeneratePitch) await this.recoverInterruptedGeneratePitch(job, { code: 'LEASE_EXPIRED', message: 'Qwen pitch lease expired before completion.' });
    for (const job of expiredV1) await this.terminalizeInterruptedCandidate(job, { code: 'LEASE_EXPIRED', message: 'Controller lease expired before completion.' });
    return { released, expiredGeneratePitch, expiredV1 };
  }

  async reconcileExpiredV1Jobs() { return this.reconcileExpiredJobs(); }
}
