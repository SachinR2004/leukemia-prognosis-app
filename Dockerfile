# Use Python 3.10
FROM python:3.10

# Set working directory
WORKDIR /code

# Copy requirements and install dependencies
COPY ./requirements.txt /code/requirements.txt
RUN pip install --no-cache-dir --upgrade -r /code/requirements.txt

# Copy the rest of the application
COPY . /code

# Create models directory permission fix (Safety check)
RUN mkdir -p /code/models && chmod -R 777 /code

# Run the application with a LONG TIMEOUT (120s) to allow models to load
CMD ["gunicorn", "-b", "0.0.0.0:7860", "--timeout", "120", "app:app"]
