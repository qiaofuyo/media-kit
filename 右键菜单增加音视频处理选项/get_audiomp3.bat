@echo off
set "input=%~1"
set "filename=%~n1"
set "output=%~dp1%filename%_.mp3"

ffmpeg -i "%input%"  -vn -c:a libmp3lame -q:a 2 "%output%"