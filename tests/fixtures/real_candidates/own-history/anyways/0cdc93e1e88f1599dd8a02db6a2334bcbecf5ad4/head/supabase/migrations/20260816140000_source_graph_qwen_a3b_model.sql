-- Align the durable canonical pitch queue with the validated local A3B MoE
-- model. Existing completed jobs are historical evidence and are preserved.
begin;

alter table public.source_graph_discovery_settings
  alter column qwen_model set default 'qwen3.6:35b-a3b-nvfp4';

update public.source_graph_discovery_settings
set qwen_model = 'qwen3.6:35b-a3b-nvfp4', updated_at = now()
where id = 'default';

-- Only queued jobs are rewritten. A claimed or running job keeps the model it
-- was already handed so an in-flight execution cannot be mutated underneath
-- the controller.
update public.pipeline_jobs
set parameters = jsonb_set(parameters, '{model}', to_jsonb('qwen3.6:35b-a3b-nvfp4'::text))
where job_type = 'generate_pitch'
  and status = 'queued'
  and parameters ->> 'model' in ('qwen3:14b', 'qwen3:30b');

comment on column public.source_graph_discovery_settings.qwen_model is
  'Local model name used by threshold-passed generate_pitch jobs. It must match the persistent controller Ollama installation.';

commit;
