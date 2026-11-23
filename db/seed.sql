-- Idempotent seed of the 12 default Canopy interest channels.

INSERT INTO interests (slug, label, category)
VALUES
  ('gaming', 'Gaming', 'play'),
  ('music-production', 'Music Production', 'creative'),
  ('late-night-coding', 'Late-Night Coding', 'tech'),
  ('chess', 'Chess', 'play'),
  ('sci-fi-cinema', 'Sci-Fi & Cinema', 'culture'),
  ('fitness', 'Strength & Running', 'health'),
  ('cooking', 'Home Cooking', 'lifestyle'),
  ('indie-books', 'Indie Books', 'culture'),
  ('board-games', 'Tabletop & Strategy', 'play'),
  ('language-practice', 'Spoken Languages', 'social'),
  ('electronic-art', 'Synth & Visual Art', 'creative'),
  ('philosophy', 'Open Philosophy', 'social')
AS seeded
ON DUPLICATE KEY UPDATE
  label = seeded.label,
  category = seeded.category;
