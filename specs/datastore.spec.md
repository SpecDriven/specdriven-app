# Git-based data store

When we try to `git clone https://....` we may get 

`Could not clone https://github.com/SpecDriven/data-insurance: Cloning into '/home/jsmiller/projects/specdriven/data-insurance'...
 fatal: could not read Username for 'https://github.com': terminal prompts disabled`

## Probe multiple git clone schemes

if https:// clone fails, try ssh-based git clone
