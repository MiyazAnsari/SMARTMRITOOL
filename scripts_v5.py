# -*- coding: utf-8 -*-
"""Run the full v5 pipeline from the command line.

Outputs only under analysis_outputs_v5/ — never overwrites live redo_tracker.xlsx.
"""
from scripts_v5_lib import run_pipeline

if __name__ == "__main__":
    run_pipeline(make_ba_plots=False, run_planar=True, jmp_include_single_rater=True)
