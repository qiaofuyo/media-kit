@echo off
set "input=%~1"
set "filename=%~n1"
set "output=%~dp1%filename%_.flac"

ffmpeg -i "%input%"  -vn -c:a flac -compression_level 12 "%output%"