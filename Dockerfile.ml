# Dockerfile for CollabLab Python Data Science & Machine Learning Execution
# Builds an offline-ready image containing standard data science libraries.
# Usage:
#   docker build -t collablab-python -f Dockerfile.ml .
# Then set PYTHON_DOCKER_IMAGE=collablab-python in your environment!

FROM python:3.10-slim

# Install core data science and ML libraries
RUN pip install --no-cache-dir \
    numpy \
    pandas \
    scipy \
    matplotlib \
    seaborn \
    scikit-learn \
    tabulate

# Set matplotlib backend to Agg so plotting functions don't crash when run without a GUI display
ENV MPLBACKEND=Agg

WORKDIR /app
