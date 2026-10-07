export const MATERIALIZABLE_PIPELINE_STATUSES = new Set(['ready_for_review', 'approved']);

export function materializationState(candidate, link) {
  if (link?.story_id) return { action: 'open', eligible: true, storyId: link.story_id };
  return {
    action: 'create',
    eligible: MATERIALIZABLE_PIPELINE_STATUSES.has(candidate?.status),
    storyId: null
  };
}

export function imageMayMaterialize(image) {
  return Boolean(image?.selected) && ['verified_reusable', 'official_press_asset'].includes(image.rights_status);
}
