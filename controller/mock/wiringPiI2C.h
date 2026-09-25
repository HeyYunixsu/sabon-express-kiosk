#ifndef MOCK_WIRINGPII2C_H
#define MOCK_WIRINGPII2C_H

#ifdef __cplusplus
extern "C" {
#endif

int wiringPiI2CSetup(int devId);
int wiringPiI2CRead(int fd);
int wiringPiI2CReadReg8(int fd, int reg);
int wiringPiI2CReadReg16(int fd, int reg);
int wiringPiI2CWrite(int fd, int data);
int wiringPiI2CWriteReg8(int fd, int reg, int data);
int wiringPiI2CWriteReg16(int fd, int reg, int data);

#ifdef __cplusplus
}
#endif

#endif // MOCK_WIRINGPII2C_H
