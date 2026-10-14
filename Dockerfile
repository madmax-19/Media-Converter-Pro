
FROM python:3.12-slim

# Install FFmpeg, Node.js, and required tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    ffmpeg \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install Deno
ENV DENO_INSTALL=/root/.deno
ENV PATH="/root/.deno/bin:${PATH}"

RUN curl -fsSL https://deno.land/install.sh | sh

# Set working directory
WORKDIR /app

# Install Python dependencies
COPY requirements.txt .

RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir -r requirements.txt \
    && python -m pip install --no-cache-dir --upgrade "yt-dlp[default]"

# Copy application files
COPY . .

# Start FastAPI
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-10000}"]

