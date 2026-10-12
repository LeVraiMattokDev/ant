CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ant_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;
