-- mail_welcome's 5th argument, p_kickoff_url, is dead: mark_paid passes biz('kickoff_link')
-- and the template never reads it. That is right, not a bug to fill in — a client books their
-- kickoff by replying to the times we post in their channel, so the welcome email has nowhere
-- to put a booking link.
-- Kept rather than dropped: three live callers pass five arguments, and the house rule is to
-- avoid DROP. So the function is left exactly as it is and only labelled, so the next person
-- reading the database does not go looking for the missing link.
comment on function public.mail_welcome(uuid, text, text, text, text) is
  'The welcome email after the first payment. p_kickoff_url is accepted and ignored on purpose: '
  'the kickoff is booked by replying to the times posted in the client channel, not from a link. '
  'Kept in the signature so the existing callers (mark_paid and the close-to-onboarded path) '
  'do not have to change.';
