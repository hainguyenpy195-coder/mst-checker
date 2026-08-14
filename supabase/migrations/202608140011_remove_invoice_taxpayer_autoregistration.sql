-- Invoice imports must not create taxpayer catalogue rows or enqueue refreshes.
-- The application now stores the invoice and reports a missing seller MST so an
-- administrator can add and refresh it separately. Remove the legacy RPC so
-- an old server route cannot re-enable the previous behavior.

drop function if exists public.ensure_invoice_taxpayer(text, text, text, text);
