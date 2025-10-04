@echo off
set "input=%~1"
set "filename=%~n1"
set "ext=%~x1"
set "output=%~dp1%filename%_%ext%"

ffmpeg -i "%input%"  -vcodec libx264 -crf 24 -b:v 1200k -vf scale=1280:720 -r 24 -b:a 96k -ar 44100 "%output%"